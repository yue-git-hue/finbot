"use strict";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");
const fetch = require("node-fetch");
const path = require("path");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

const JWT_SECRET  = process.env.JWT_SECRET  || "finbot-secret-change-me";
const ADMIN_KEY   = process.env.ADMIN_KEY   || "finbot-admin-2026";
const HPJ_APPID   = process.env.HPJ_APPID   || "";   // 虎皮椒 AppID
const HPJ_SECRET  = process.env.HPJ_SECRET  || "";   // 虎皮椒 AppSecret
const BASE_URL    = process.env.BASE_URL    || "http://localhost:3723";

// ── 套餐配置 ─────────────────────────────────────────
const PLANS = {
  monthly:   { name: "月付套餐", price: 29900, days: 30  },  // 单位：分
  quarterly: { name: "季付套餐", price: 79900, days: 90  },
  yearly:    { name: "年付套餐", price: 299900, days: 365 },
};

// ── 中间件 ───────────────────────────────────────────
function authUser(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "未登录" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "登录已过期，请重新登录" }); }
}

function authAdmin(req, res, next) {
  const k = req.headers["x-admin-key"] || req.query.admin;
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "无权限" });
  next();
}

// ── 用户注册 ─────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  const { email, password, name, company } = req.body;
  if (!email || !password) return res.status(400).json({ error: "邮箱和密码必填" });
  if (password.length < 6) return res.status(400).json({ error: "密码至少6位" });
  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (exists) return res.status(400).json({ error: "该邮箱已注册" });
  const hash = await bcrypt.hash(password, 10);
  db.prepare("INSERT INTO users(email,password,name,company) VALUES(?,?,?,?)").run(email, hash, name||"", company||"");
  res.json({ ok: true, message: "注册成功，请购买套餐后使用" });
});

// ── 用户登录 ─────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user) return res.status(400).json({ error: "邮箱或密码错误" });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: "邮箱或密码错误" });

  // 检查是否过期
  if (user.expires && user.expires < new Date().toISOString().slice(0,10)) {
    db.prepare("UPDATE users SET status='expired' WHERE id=?").run(user.id);
    user.status = "expired";
  }

  db.prepare("UPDATE users SET last_login=datetime('now','localtime') WHERE id=?").run(user.id);
  db.prepare("INSERT INTO usage_log(user_id,email,action) VALUES(?,?,?)").run(user.id, email, "login");

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({
    ok: true, token,
    user: { email: user.email, name: user.name, company: user.company, status: user.status, plan: user.plan, expires: user.expires }
  });
});

// ── 免费试用 ──────────────────────────────────────────
const FREE_LIMIT = 3;

app.get("/api/trial", authUser, (req, res) => {
  const user = db.prepare("SELECT free_uses, status FROM users WHERE id=?").get(req.user.id);
  const remaining = Math.max(0, FREE_LIMIT - (user?.free_uses || 0));
  res.json({ remaining, limit: FREE_LIMIT, isActive: user?.status === "active" });
});

app.post("/api/trial/use", authUser, (req, res) => {
  const user = db.prepare("SELECT free_uses, status FROM users WHERE id=?").get(req.user.id);
  if (user?.status === "active") return res.json({ ok: true, remaining: FREE_LIMIT });
  const used = user?.free_uses || 0;
  if (used >= FREE_LIMIT) return res.status(403).json({ error: "免费次数已用完，请订阅后继续使用" });
  db.prepare("UPDATE users SET free_uses=free_uses+1 WHERE id=?").run(req.user.id);
  db.prepare("INSERT INTO usage_log(user_id,email,action) VALUES(?,?,?)").run(req.user.id, req.user.email, "free_trial");
  res.json({ ok: true, remaining: FREE_LIMIT - used - 1 });
});

// ── 获取用户信息 ─────────────────────────────────────
app.get("/api/me", authUser, (req, res) => {
  const user = db.prepare("SELECT email,name,company,status,plan,expires,created FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  // 检查过期
  if (user.expires && user.expires < new Date().toISOString().slice(0,10)) {
    db.prepare("UPDATE users SET status='expired' WHERE id=?").run(req.user.id);
    user.status = "expired";
  }
  res.json(user);
});

// ── 创建订单（虎皮椒）─────────────────────────────────
app.post("/api/order/create", authUser, async (req, res) => {
  const { plan } = req.body;
  const p = PLANS[plan];
  if (!p) return res.status(400).json({ error: "无效套餐" });

  const outTradeNo = "FB" + Date.now() + nanoid(6).toUpperCase();
  db.prepare("INSERT INTO orders(user_id,out_trade_no,plan,amount,days) VALUES(?,?,?,?,?)").run(req.user.id, outTradeNo, plan, p.price/100, p.days);

  if (!HPJ_APPID || !HPJ_SECRET) {
    // 开发模式：返回模拟支付链接
    return res.json({ ok: true, payUrl: `${BASE_URL}/pay-mock?order=${outTradeNo}&amount=${p.price/100}&name=${encodeURIComponent(p.name)}`, outTradeNo, mock: true });
  }

  // 虎皮椒正式接口
  try {
    const params = new URLSearchParams({
      version: "1.1",
      appid: HPJ_APPID,
      trade_order_id: outTradeNo,
      total_fee: p.price,
      title: p.name + " - FINBOT票据预审",
      notify_url: `${BASE_URL}/api/order/notify`,
      return_url: `${BASE_URL}/app?pay=success`,
      dtype: "WAP",
    });
    const sign = require("crypto").createHash("md5")
      .update(`${HPJ_APPID}${outTradeNo}${p.price}${p.name+" - FINBOT票据预审"}${HPJ_SECRET}`)
      .digest("hex");
    params.set("sign", sign);

    const r = await fetch("https://api.xunhupay.com/payment/do.html", { method: "POST", body: params });
    const d = await r.json();
    if (d.errcode !== 0) throw new Error(d.errmsg || "创建订单失败");
    res.json({ ok: true, payUrl: d.url, outTradeNo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 模拟支付页面（开发/演示用）─────────────────────────
app.get("/pay-mock", (req, res) => {
  const { order, amount, name } = req.query;
  res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>模拟支付</title>
<style>body{font-family:system-ui;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border-radius:16px;padding:40px;text-align:center;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,0.08)}
h2{font-size:20px;margin-bottom:8px}.amount{font-size:40px;font-weight:800;color:#2563EB;margin:20px 0}
.btn{display:block;width:100%;padding:14px;background:#2563EB;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;margin-top:16px}
.btn:hover{background:#1D4ED8}.note{font-size:12px;color:#94A3B8;margin-top:12px}</style></head>
<body><div class="box">
<div style="font-size:32px">📱</div>
<h2>${decodeURIComponent(name||"")}</h2>
<div class="amount">¥${amount}</div>
<p style="color:#475569;font-size:14px">这是演示支付页面</p>
<button class="btn" onclick="pay('${order}')">确认支付（演示）</button>
<div class="note">正式上线后替换为真实支付</div>
</div>
<script>
async function pay(order){
  this.disabled=true;
  await fetch('/api/order/mock-pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outTradeNo:order})});
  location.href='/app?pay=success';
}
</script></body></html>`);
});

// ── 模拟支付回调 ─────────────────────────────────────
app.post("/api/order/mock-pay", (req, res) => {
  const { outTradeNo } = req.body;
  activateOrder(outTradeNo);
  res.json({ ok: true });
});

// ── 虎皮椒支付回调 ───────────────────────────────────
app.post("/api/order/notify", express.urlencoded({ extended: true }), (req, res) => {
  const { trade_order_id, openid, status } = req.body;
  if (status === "OD") {
    activateOrder(trade_order_id);
    res.send("success");
  } else {
    res.send("fail");
  }
});

function activateOrder(outTradeNo) {
  const order = db.prepare("SELECT * FROM orders WHERE out_trade_no=?").get(outTradeNo);
  if (!order || order.status === "paid") return;
  db.prepare("UPDATE orders SET status='paid', paid_at=datetime('now','localtime') WHERE out_trade_no=?").run(outTradeNo);
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(order.user_id);
  if (!user) return;
  // 计算到期日（续费叠加）
  const base = user.expires && user.expires > new Date().toISOString().slice(0,10) ? new Date(user.expires) : new Date();
  base.setDate(base.getDate() + order.days);
  const expires = base.toISOString().slice(0,10);
  db.prepare("UPDATE users SET status='active', plan=?, expires=? WHERE id=?").run(order.plan, expires, order.user_id);
  db.prepare("INSERT INTO usage_log(user_id,email,action) VALUES(?,?,?)").run(user.id, user.email, "paid:" + order.plan);
}


// ── AI 识别代理（客户无需填Key）────────────────────────
app.post("/api/ai/recognize", authUser, async (req, res) => {
  const sfKey = process.env.SF_KEY;
  if (!sfKey) return res.status(500).json({ error: "AI服务未配置，请联系管理员" });

  try {
    const r = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + sfKey },
      body: JSON.stringify(req.body),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: "AI服务错误: " + t.slice(0, 200) });
    }
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── 审核记录存取 ──────────────────────────────────────

// 保存一批记录
app.post("/api/records", authUser, (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: "格式错误" });
  const insert = db.prepare(`
    INSERT INTO records (user_id,file_name,doc_type,date,amount,tax,party,doc_no,tax_no,title,category,memo,manual_review,risks,duplicate,edited,pages)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const checkExists = db.prepare("SELECT id FROM records WHERE user_id=? AND doc_no=? AND doc_no != ''");
  const insertMany = db.transaction((rows) => {
    let saved = 0;
    for (const r of rows) {
      // 跳过发票号已存在的记录，避免重复入库
      if (r.docNo && checkExists.get(req.user.id, r.docNo)) continue;
      insert.run(
        req.user.id, r.fileName||"", r.docType||"", r.date||"",
        Number(r.amount)||0, Number(r.tax)||0, r.party||"", r.docNo||"",
        r.taxNo||"", r.title||"", r.category||"", r.memo||"",
        r.manualReview||null, JSON.stringify(r.risks||[]),
        r.duplicate?1:0, r.edited?1:0, r.pages||1
      );
      saved++;
    }
    return saved;
  });
  const saved = insertMany(records);
  res.json({ ok: true, count: saved });
});

// 获取历史记录
app.get("/api/records", authUser, (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM records WHERE user_id=? ORDER BY created_at DESC LIMIT 500"
  ).all(req.user.id);
  const records = rows.map(r => ({
    id: r.id,
    fileName: r.file_name,
    docType: r.doc_type,
    date: r.date,
    amount: r.amount,
    tax: r.tax,
    party: r.party,
    docNo: r.doc_no,
    taxNo: r.tax_no,
    title: r.title,
    category: r.category,
    memo: r.memo,
    manualReview: r.manual_review,
    risks: JSON.parse(r.risks||"[]"),
    duplicate: !!r.duplicate,
    edited: !!r.edited,
    pages: r.pages,
    createdAt: r.created_at,
  }));
  res.json(records);
});

// 删除单条记录
app.delete("/api/records/:id", authUser, (req, res) => {
  db.prepare("DELETE FROM records WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// 清空所有记录
app.delete("/api/records", authUser, (req, res) => {
  db.prepare("DELETE FROM records WHERE user_id=?").run(req.user.id);
  res.json({ ok: true });
});

// 更新单条记录
app.put("/api/records/:id", authUser, (req, res) => {
  const r = req.body;
  db.prepare(`UPDATE records SET
    doc_type=?, date=?, amount=?, tax=?, party=?, doc_no=?, tax_no=?,
    title=?, category=?, memo=?, edited=1
    WHERE id=? AND user_id=?
  `).run(r.docType||"", r.date||"", Number(r.amount)||0, Number(r.tax)||0,
    r.party||"", r.docNo||"", r.taxNo||"", r.title||"", r.category||"",
    r.memo||"", req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── 重置免费次数 ─────────────────────────────────────
app.post("/api/admin/reset-trial", authAdmin, (req, res) => {
  const { id } = req.body;
  db.prepare("UPDATE users SET free_uses=0 WHERE id=?").run(id);
  res.json({ ok: true });
});

// ── 管理后台 API ─────────────────────────────────────
app.get("/api/admin/users", authAdmin, (req, res) => {
  const users = db.prepare("SELECT id,email,name,company,status,plan,expires,free_uses,created,last_login FROM users ORDER BY created DESC").all();
  res.json(users);
});

app.post("/api/admin/user-status", authAdmin, (req, res) => {
  const { id, status } = req.body;
  if (!["active","paused","inactive","expired"].includes(status)) return res.status(400).json({ error: "无效状态" });
  db.prepare("UPDATE users SET status=? WHERE id=?").run(status, id);
  res.json({ ok: true });
});

app.post("/api/admin/extend", authAdmin, (req, res) => {
  const { id, days, plan } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  const base = user.expires && user.expires > new Date().toISOString().slice(0,10) ? new Date(user.expires) : new Date();
  base.setDate(base.getDate() + Number(days));
  const expires = base.toISOString().slice(0,10);
  if (plan) {
    db.prepare("UPDATE users SET status='active', expires=?, plan=? WHERE id=?").run(expires, plan, id);
  } else {
    db.prepare("UPDATE users SET status='active', expires=? WHERE id=?").run(expires, id);
  }
  res.json({ ok: true, expires });
});

app.get("/api/admin/stats", authAdmin, (req, res) => {
  const total  = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
  const active = db.prepare("SELECT COUNT(*) as n FROM users WHERE status='active'").get().n;
  const paused = db.prepare("SELECT COUNT(*) as n FROM users WHERE status='paused'").get().n;
  const trial  = db.prepare("SELECT COUNT(*) as n FROM users WHERE status!='active' AND free_uses>0 AND free_uses<3").get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) as n FROM orders WHERE status='paid'").get().n;
  const logs  = db.prepare("SELECT * FROM usage_log ORDER BY ts DESC LIMIT 100").all();
  res.json({ total, active, paused, trial, revenue, logs });
});

app.get("/api/admin/orders", authAdmin, (req, res) => {
  const orders = db.prepare(`SELECT o.*,u.email,u.name FROM orders o LEFT JOIN users u ON o.user_id=u.id ORDER BY o.created DESC LIMIT 200`).all();
  res.json(orders);
});

// ── 管理后台页面 ─────────────────────────────────────
app.get("/admin", authAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

// ── 应用主页 ─────────────────────────────────────────
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/app.html"));
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

const PORT = process.env.PORT || 3723;
app.listen(PORT, () => {
  console.log(`\nFINBOT SaaS 已启动: http://localhost:${PORT}`);
  console.log(`管理后台: http://localhost:${PORT}/admin?admin=${ADMIN_KEY}\n`);
});
