"use strict";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");
const fetch = require("node-fetch");
const crypto = require("crypto");
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
  // 基础版（硅基 Qwen）
  monthly:       { name: "基础版·月付", price: 39900,  days: 30,  pro: false },
  quarterly:     { name: "基础版·季付", price: 109900, days: 90,  pro: false },
  yearly:        { name: "基础版·年付", price: 399900, days: 365, pro: false },
  // 强化版（OpenAI GPT-4o）
  monthly_pro:   { name: "强化版·月付", price: 79900,  days: 30,  pro: true  },
  quarterly_pro: { name: "强化版·季付", price: 219900, days: 90,  pro: true  },
  yearly_pro:    { name: "强化版·年付", price: 859900, days: 365, pro: true  },
};

// ── 虎皮椒 V3 签名算法 ──────────────────────────────────
// hash = MD5(appid + time + appsecret)
function hpjHash(appId, time, appSecret) {
  return crypto.createHash("md5").update(appId + time + appSecret).digest("hex");
}

// ── 中间件 ───────────────────────────────────────────

// ── 邮件发送（Resend HTTP API）────────────────────────
async function sendMail(to, subject, html) {
  const key = process.env.RESEND_KEY;
  if (!key) { console.log(`[邮件跳过-未配置RESEND_KEY] to=${to}`); return; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      from: "FINBOT票据预审 <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Resend发送失败: " + t);
  }
}

function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

function checkCodeLimit(email, ip) {
  const now = Date.now();
  const min60 = new Date(now - 3600000).toISOString();
  const min1  = new Date(now - 60000).toISOString();
  const recent = db.prepare("SELECT id FROM email_codes WHERE email=? AND created_at>? ORDER BY id DESC LIMIT 1").get(email, min1);
  if (recent) return "发送太频繁，请60秒后再试";
  const h = db.prepare("SELECT COUNT(*) as n FROM email_codes WHERE email=? AND created_at>?").get(email, min60);
  if (h.n >= 5) return "1小时内发送次数过多，请稍后再试";
  if (ip) {
    const ih = db.prepare("SELECT COUNT(*) as n FROM email_codes WHERE ip=? AND created_at>?").get(ip, min60);
    if (ih.n >= 10) return "操作过于频繁，请稍后再试";
  }
  return null;
}

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

// ── 发送验证码 ────────────────────────────────────────
app.post("/api/auth/send-code", async (req, res) => {
  const { email, type } = req.body;
  if (!email) return res.status(400).json({ error: "请填写邮箱" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  const ip = (req.headers["x-forwarded-for"]||"").split(",")[0].trim() || req.ip;
  const limit = checkCodeLimit(email, ip);
  if (limit) return res.status(429).json({ error: limit });
  if (type === "register") {
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(400).json({ error: "该邮箱已注册" });
  }
  if (type === "reset") {
    if (!db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(400).json({ error: "该邮箱未注册" });
  }
  const code = genCode();
  const expireAt = new Date(Date.now() + 5 * 60000).toISOString();
  db.prepare("INSERT INTO email_codes(email,code,type,expire_at,ip) VALUES(?,?,?,?,?)").run(email, code, type||"register", expireAt, ip||"");
  try {
    await sendMail(email, "FINBOT 验证码",
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1E40AF">FINBOT 验证码</h2>
        <p>您的验证码是：</p>
        <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#2563EB;padding:20px 0">${code}</div>
        <p style="color:#64748B;font-size:13px">验证码5分钟内有效，请勿泄露给他人。</p>
      </div>`
    );
    res.json({ ok: true, message: "验证码已发送，请查收邮件" });
  } catch(e) {
    console.error("[邮件发送失败]", e.message);
    res.status(500).json({ error: "邮件发送失败：" + e.message });
  }
});

// ── 注册 ──────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  const { phone, password, name, company } = req.body;
  if (!phone || !password) return res.status(400).json({ error: "手机号和密码必填" });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: "手机号格式不正确" });
  if (password.length < 6) return res.status(400).json({ error: "密码至少6位" });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(phone)) return res.status(400).json({ error: "该手机号已注册" });
  const hash = await bcrypt.hash(password, 10);
  db.prepare("INSERT INTO users(email,password,name,company) VALUES(?,?,?,?)").run(phone, hash, name||"", company||"");
  res.json({ ok: true, message: "注册成功" });
});

// ── 忘记密码 ─────────────────────────────────────────
app.post("/api/auth/forgot-password/reset", async (req, res) => {
  const { email, code, password } = req.body;
  if (!email || !code || !password) return res.status(400).json({ error: "邮箱、验证码和新密码必填" });
  if (password.length < 6) return res.status(400).json({ error: "密码至少6位" });
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (!user) return res.status(400).json({ error: "该邮箱未注册" });
  const now = new Date().toISOString();
  const vc = db.prepare("SELECT * FROM email_codes WHERE email=? AND type='reset' AND used=0 AND expire_at>? ORDER BY id DESC LIMIT 1").get(email, now);
  if (!vc || vc.code !== code) return res.status(400).json({ error: "验证码错误或已过期" });
  db.prepare("UPDATE email_codes SET used=1 WHERE id=?").run(vc.id);
  const hash = await bcrypt.hash(password, 10);
  db.prepare("UPDATE users SET password=? WHERE id=?").run(hash, user.id);
  res.json({ ok: true, message: "密码已重置，请重新登录" });
});

// ── 登录 ─────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user) return res.status(400).json({ error: "手机号或密码错误" });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: "手机号或密码错误" });

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
const MONTHLY_LIMIT = 3000;

app.get("/api/trial", authUser, (req, res) => {
  const user = db.prepare("SELECT free_uses, status, month_uses, month_year FROM users WHERE id=?").get(req.user.id);
  const remaining = Math.max(0, FREE_LIMIT - (user?.free_uses || 0));
  const curMonth = new Date().toISOString().slice(0,7);
  const monthUses = (user?.month_year === curMonth) ? (user?.month_uses || 0) : 0;
  const monthRemaining = Math.max(0, MONTHLY_LIMIT - monthUses);
  res.json({ remaining, limit: FREE_LIMIT, isActive: user?.status === "active", monthUses, monthRemaining, monthLimit: MONTHLY_LIMIT });
});

app.post("/api/trial/use", authUser, (req, res) => {
  const count = Math.max(1, parseInt(req.body?.count) || 1);
  const user = db.prepare("SELECT free_uses, status, month_uses, month_year FROM users WHERE id=?").get(req.user.id);
  const curMonth = new Date().toISOString().slice(0,7);

  if (user?.status === "active") {
    const monthUses = (user?.month_year === curMonth) ? (user?.month_uses || 0) : 0;
    if (monthUses >= MONTHLY_LIMIT) {
      return res.status(403).json({ error: `本月识别次数已达上限（${MONTHLY_LIMIT}张），下月自动重置` });
    }
    const newUses = monthUses + count;
    if (user?.month_year !== curMonth) {
      db.prepare("UPDATE users SET month_uses=?, month_year=? WHERE id=?").run(count, curMonth, req.user.id);
    } else {
      db.prepare("UPDATE users SET month_uses=month_uses+? WHERE id=?").run(count, req.user.id);
    }
    db.prepare("INSERT INTO usage_log(user_id,email,action) VALUES(?,?,?)").run(req.user.id, req.user.email, `recognize:${count}张`);
    return res.json({ ok: true, remaining: FREE_LIMIT, monthRemaining: Math.max(0, MONTHLY_LIMIT - newUses) });
  }

  const used = user?.free_uses || 0;
  if (used >= FREE_LIMIT) return res.status(403).json({ error: "免费次数已用完，请订阅后继续使用" });
  const deduct = Math.min(count, FREE_LIMIT - used);
  db.prepare("UPDATE users SET free_uses=free_uses+? WHERE id=?").run(deduct, req.user.id);
  db.prepare("INSERT INTO usage_log(user_id,email,action) VALUES(?,?,?)").run(req.user.id, req.user.email, `free_trial:${deduct}张`);
  res.json({ ok: true, remaining: FREE_LIMIT - used - deduct });
});

// ── 获取用户信息 ─────────────────────────────────────
app.get("/api/me", authUser, (req, res) => {
  const user = db.prepare("SELECT email,name,company,status,plan,expires,created FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.expires && user.expires < new Date().toISOString().slice(0,10)) {
    db.prepare("UPDATE users SET status='expired' WHERE id=?").run(req.user.id);
    user.status = "expired";
  }
  res.json(user);
});

// ════════════════════════════════════════════════════
// ── 支付模块（虎皮椒微信支付）────────────────────────
// ════════════════════════════════════════════════════

// ── 创建订单 ─────────────────────────────────────────
app.post("/api/order/create", authUser, async (req, res) => {
  const { plan } = req.body;
  const p = PLANS[plan];
  if (!p) return res.status(400).json({ error: "无效套餐" });

  const outTradeNo = "FB" + Date.now() + nanoid(6).toUpperCase();
  db.prepare("INSERT INTO orders(user_id,out_trade_no,plan,amount,days) VALUES(?,?,?,?,?)")
    .run(req.user.id, outTradeNo, plan, p.price / 100, p.days);

  // ── 开发模式（未配置虎皮椒）─────────────────────────
  if (!HPJ_APPID || !HPJ_SECRET) {
    return res.json({
      ok: true,
      payUrl: `${BASE_URL}/pay-mock?order=${outTradeNo}&amount=${p.price/100}&name=${encodeURIComponent(p.name)}`,
      outTradeNo,
      mock: true,
    });
  }

  // ── 正式：调用虎皮椒下单接口 ────────────────────────
  try {
    const title     = p.name + " - FINBOT票据预审";
    const notifyUrl = `${BASE_URL}/api/order/notify`;
    const returnUrl = `${BASE_URL}/app?pay=success&order=${outTradeNo}`;
    const time      = String(Math.floor(Date.now() / 1000));
    const hash      = hpjHash(HPJ_APPID, time, HPJ_SECRET);

    const params = new URLSearchParams({
      appid:          HPJ_APPID,
      time,
      hash,
      out_order_id:   outTradeNo,
      total_fee:      String(p.price),   // 单位：分
      title,
      notify_url:     notifyUrl,
      return_url:     returnUrl,
      dtype:          "WAP",             // WAP = H5微信支付跳转
    });

    const r = await fetch("https://api.xunhupay.com/payment/do.html", {
      method: "POST",
      body: params,
    });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch(e) {
      console.error("[HPJ响应非JSON]", text.slice(0, 300));
      throw new Error("虎皮椒接口返回异常，请检查APPID和域名配置");
    }

    // 正常响应：{ ret:200, data:{ pay_url:"...", trade_order_id:"..." }, msg:"" }
    if (d.ret !== 200 || !d.data?.pay_url) {
      throw new Error(d.msg || d.data?.errmsg || JSON.stringify(d));
    }

    res.json({ ok: true, payUrl: d.data.pay_url, outTradeNo });
  } catch (e) {
    console.error("[HPJ下单失败]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 查询订单状态（前端轮询用）────────────────────────
// GET /api/order/status?order=FB123456ABC
app.get("/api/order/status", authUser, async (req, res) => {
  const { order } = req.query;
  if (!order) return res.status(400).json({ error: "缺少 order 参数" });

  const row = db.prepare("SELECT * FROM orders WHERE out_trade_no=? AND user_id=?").get(order, req.user.id);
  if (!row) return res.status(404).json({ error: "订单不存在" });

  // 本地已标记为 paid，直接返回
  if (row.status === "paid") {
    return res.json({ ok: true, paid: true, paidAt: row.paid_at });
  }

  // 向虎皮椒主动查询
  if (HPJ_APPID && HPJ_SECRET) {
    try {
      const time = String(Math.floor(Date.now() / 1000));
      const hash = hpjHash(HPJ_APPID, time, HPJ_SECRET);
      const body = new URLSearchParams({ appid: HPJ_APPID, time, hash, out_order_id: order });
      const r = await fetch("https://api.xunhupay.com/payment/query.html", { method: "POST", body });
      const d = await r.json();
      // 响应：{ ret:200, data:{ status:"OD"|"WP", ... } }
      if (d.ret === 200 && d.data?.status === "OD") {
        activateOrder(order);
        return res.json({ ok: true, paid: true });
      }
    } catch (e) {
      console.error("[HPJ查单失败]", e.message);
    }
  }

  res.json({ ok: true, paid: false, status: row.status });
});

// ── 虎皮椒异步回调 ────────────────────────────────────
app.post("/api/order/notify", express.urlencoded({ extended: true }), (req, res) => {
  // 虎皮椒回调字段：out_order_id 或 trade_order_id（兼容两种）
  const out_order_id = req.body.out_order_id || req.body.trade_order_id;
  const { status, appid, time, hash } = req.body;

  // 验签：hash = MD5(appid + time + appsecret)
  if (HPJ_SECRET && appid && time && hash) {
    const expected = hpjHash(appid, time, HPJ_SECRET);
    if (hash !== expected) {
      console.error("[HPJ回调验签失败]", { received: hash, expected });
      return res.send("fail");
    }
  }

  if (status === "OD") {
    activateOrder(out_order_id);
    res.send("success");
  } else {
    res.send("fail");
  }
});

// ── 订单激活（幂等，可重复调用）──────────────────────
function activateOrder(outTradeNo) {
  const order = db.prepare("SELECT * FROM orders WHERE out_trade_no=?").get(outTradeNo);
  if (!order || order.status === "paid") return; // 已处理，跳过

  db.prepare("UPDATE orders SET status='paid', paid_at=datetime('now','localtime') WHERE out_trade_no=?").run(outTradeNo);

  const user = db.prepare("SELECT * FROM users WHERE id=?").get(order.user_id);
  if (!user) return;

  // 续费叠加：若当前未过期则从过期日延续，否则从今天起算
  const base = (user.expires && user.expires > new Date().toISOString().slice(0,10))
    ? new Date(user.expires)
    : new Date();
  base.setDate(base.getDate() + order.days);
  const expires = base.toISOString().slice(0,10);

  const isPro = PLANS[order.plan]?.pro ? 1 : 0;
  db.prepare("UPDATE users SET status='active', plan=?, expires=?, is_pro=? WHERE id=?")
    .run(order.plan, expires, isPro, order.user_id);
  db.prepare("INSERT INTO usage_log(user_id,email,action) VALUES(?,?,?)")
    .run(user.id, user.email, "paid:" + order.plan);

  console.log(`[支付成功] user=${user.email} plan=${order.plan} expires=${expires}`);
}

// ── 模拟支付页面（开发/演示用，正式上线不影响）─────────
app.get("/pay-mock", (req, res) => {
  const { order, amount, name } = req.query;
  res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>模拟支付</title>
<style>body{font-family:system-ui;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border-radius:16px;padding:40px;text-align:center;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,0.08)}
h2{font-size:20px;margin-bottom:8px}.amount{font-size:40px;font-weight:800;color:#2563EB;margin:20px 0}
.btn{display:block;width:100%;padding:14px;background:#07C160;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;margin-top:16px}
.btn:hover{opacity:0.9}.note{font-size:12px;color:#94A3B8;margin-top:12px}</style></head>
<body><div class="box">
<div style="font-size:32px">💚</div>
<h2>${decodeURIComponent(name||"")}</h2>
<div class="amount">¥${amount}</div>
<p style="color:#475569;font-size:14px">演示模式 · 点击模拟付款成功</p>
<button class="btn" onclick="pay('${order}', this)">确认支付（演示）</button>
<div class="note">正式上线后为真实微信支付二维码</div>
</div>
<script>
async function pay(order, btn){
  btn.disabled = true;
  btn.textContent = "处理中...";
  try {
    await fetch('/api/order/mock-pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outTradeNo:order})});
    location.href = '/app?pay=success&order=' + order;
  } catch(e) {
    btn.disabled = false;
    btn.textContent = "确认支付（演示）";
    alert("出错了：" + e.message);
  }
}
</script></body></html>`);
});

// ── 模拟支付回调（开发用）────────────────────────────
app.post("/api/order/mock-pay", (req, res) => {
  const { outTradeNo } = req.body;
  if (!outTradeNo) return res.status(400).json({ error: "缺少 outTradeNo" });
  activateOrder(outTradeNo);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════
// ── AI 识别代理 ───────────────────────────────────────
// ════════════════════════════════════════════════════
app.post("/api/ai/recognize", authUser, async (req, res) => {
  const user = db.prepare("SELECT plan, is_pro FROM users WHERE id=?").get(req.user.id);
  const isPro = user?.is_pro === 1 || PLANS[user?.plan]?.pro === true;

  if (isPro) {
    const openaiKey = process.env.OPENAI_KEY;
    if (!openaiKey) return res.status(500).json({ error: "强化版AI服务未配置，请联系管理员" });
    try {
      const body = { ...req.body, model: "gpt-4o" };
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + openaiKey },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: "强化版AI服务错误: " + t.slice(0, 200) });
      }
      res.json(await r.json());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    const blKey = process.env.BAILIAN_KEY;
    if (!blKey) return res.status(500).json({ error: "AI服务未配置，请联系管理员" });
    try {
      const blBody = { ...req.body, model: "qwen3.5-flash", enable_thinking: false };
      const r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + blKey },
        body: JSON.stringify(blBody),
      });
      if (!r.ok) {
        const t = await r.text();
        console.error("[百炼错误]", r.status, t.slice(0, 300));
        return res.status(r.status).json({ error: "AI服务错误: " + t.slice(0, 200) });
      }
      res.json(await r.json());
    } catch (e) {
      console.error("[百炼异常]", e.message);
      res.status(500).json({ error: e.message });
    }
  }
});

// ── 审核记录 ──────────────────────────────────────────
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
  res.json({ ok: true, count: insertMany(records) });
});

app.get("/api/records", authUser, (req, res) => {
  const rows = db.prepare("SELECT * FROM records WHERE user_id=? ORDER BY created_at DESC LIMIT 500").all(req.user.id);
  res.json(rows.map(r => ({
    id: r.id, fileName: r.file_name, docType: r.doc_type, date: r.date,
    amount: r.amount, tax: r.tax, party: r.party, docNo: r.doc_no,
    taxNo: r.tax_no, title: r.title, category: r.category, memo: r.memo,
    manualReview: r.manual_review, risks: JSON.parse(r.risks||"[]"),
    duplicate: !!r.duplicate, edited: !!r.edited, pages: r.pages, createdAt: r.created_at,
  })));
});

app.delete("/api/records/:id", authUser, (req, res) => {
  db.prepare("DELETE FROM records WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete("/api/records", authUser, (req, res) => {
  db.prepare("DELETE FROM records WHERE user_id=?").run(req.user.id);
  res.json({ ok: true });
});

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

// ── 企业规则 ──────────────────────────────────────────
const DEFAULT_RULES = {
  hotel_limit_warn: 800, hotel_limit_reject: 1500,
  meal_pass_limit: 200, meal_review_limit: 2000,
  transport_daily_limit: 500, invoice_expire_months: 3,
  train_seat_policy: "二等座", train_seat_manager: "一等座",
  flight_seat_policy: "经济舱", flight_seat_manager: "经济舱",
  require_meal_reason: true, allow_same_city_hotel: false, company_name: "",
};

app.get("/api/rules", authUser, (req, res) => {
  const row = db.prepare("SELECT rules_json FROM company_rules WHERE user_id=?").get(req.user.id);
  res.json(row ? { ...DEFAULT_RULES, ...JSON.parse(row.rules_json) } : DEFAULT_RULES);
});

app.post("/api/rules", authUser, (req, res) => {
  const json = JSON.stringify(req.body);
  const exists = db.prepare("SELECT id FROM company_rules WHERE user_id=?").get(req.user.id);
  if (exists) {
    db.prepare("UPDATE company_rules SET rules_json=?, updated_at=datetime('now','localtime') WHERE user_id=?").run(json, req.user.id);
  } else {
    db.prepare("INSERT INTO company_rules(user_id, rules_json) VALUES(?,?)").run(req.user.id, json);
  }
  res.json({ ok: true });
});

app.delete("/api/rules", authUser, (req, res) => {
  db.prepare("DELETE FROM company_rules WHERE user_id=?").run(req.user.id);
  res.json({ ok: true });
});

// ── 管理后台 ──────────────────────────────────────────
app.post("/api/admin/reset-trial", authAdmin, (req, res) => {
  db.prepare("UPDATE users SET free_uses=0 WHERE id=?").run(req.body.id);
  res.json({ ok: true });
});

app.post("/api/admin/record-payment", authAdmin, async (req, res) => {
  const { email, amount, note } = req.body;
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  const outTradeNo = "MANUAL" + Date.now();
  db.prepare("INSERT INTO orders(user_id,out_trade_no,plan,amount,days,status,paid_at) VALUES(?,?,?,?,?,?,datetime('now','localtime'))")
    .run(user?.id || null, outTradeNo, note||"手动收款", Number(amount), 0, "paid");
  db.prepare("INSERT INTO usage_log(user_id,email,action) VALUES(?,?,?)").run(user?.id||0, email, "manual_payment:¥"+amount);
  res.json({ ok: true });
});

app.get("/api/admin/users", authAdmin, (req, res) => {
  res.json(db.prepare("SELECT id,email,name,company,status,plan,expires,free_uses,created,last_login FROM users ORDER BY created DESC").all());
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
  res.json({
    total:   db.prepare("SELECT COUNT(*) as n FROM users").get().n,
    active:  db.prepare("SELECT COUNT(*) as n FROM users WHERE status='active'").get().n,
    paused:  db.prepare("SELECT COUNT(*) as n FROM users WHERE status='paused'").get().n,
    trial:   db.prepare("SELECT COUNT(*) as n FROM users WHERE status!='active' AND free_uses>0 AND free_uses<3").get().n,
    revenue: db.prepare("SELECT COALESCE(SUM(amount),0) as n FROM orders WHERE status='paid'").get().n,
    logs:    db.prepare("SELECT * FROM usage_log ORDER BY ts DESC LIMIT 100").all(),
  });
});

app.get("/api/admin/orders", authAdmin, (req, res) => {
  res.json(db.prepare("SELECT o.*,u.email,u.name FROM orders o LEFT JOIN users u ON o.user_id=u.id ORDER BY o.created DESC LIMIT 200").all());
});

// ── 页面路由 ──────────────────────────────────────────
app.get("/admin", authAdmin, (req, res) => res.sendFile(path.join(__dirname, "../public/admin.html")));
app.get("/app",   (req, res) => res.sendFile(path.join(__dirname, "../public/app.html")));
app.get("/",      (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

const PORT = process.env.PORT || 3723;
app.listen(PORT, () => {
  console.log(`\nFINBOT SaaS 已启动: http://localhost:${PORT}`);
  console.log(`管理后台: http://localhost:${PORT}/admin?admin=${ADMIN_KEY}\n`);
});
