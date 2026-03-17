# FINBOT SaaS 部署指南

## 快速部署到 Railway（推荐，免费起步）

### 第一步：注册 Railway
1. 打开 railway.app，用 GitHub 账号注册
2. 新建项目 → "Deploy from GitHub Repo"
3. 把这个文件夹推送到你的 GitHub 仓库，然后选它

### 第二步：设置环境变量
在 Railway 项目里点 "Variables"，添加：
- `ADMIN_KEY` = 你的管理员密码（自定义，不要用默认的）
- `JWT_SECRET` = 随机字符串（比如：abcd1234efgh5678）
- `BASE_URL` = https://你的域名.railway.app（部署后在 Settings 里找）

### 第三步：获取域名
Railway 部署后自动分配域名，在 Settings → Networking → Generate Domain

---

## 接入虎皮椒真实收款

1. 注册 xunhupay.com（个人可用，无需营业执照）
2. 创建应用，获取 AppID 和 AppSecret
3. 在 Railway 环境变量里填写 `HPJ_APPID` 和 `HPJ_SECRET`
4. 虎皮椒后台设置回调地址：`https://你的域名/api/order/notify`

不填虎皮椒配置时，会显示演示支付页面（点击即完成，用于测试）。

---

## 你的管理后台

地址：`https://你的域名/admin?admin=你的ADMIN_KEY`

功能：
- 查看所有注册用户和订阅状态
- 暂停/恢复任意用户（立即生效）
- 手动给用户延期（输入邮箱或ID + 天数）
- 查看所有订单和收入
- 实时使用日志

## 客户流程

1. 客户访问你的网站首页
2. 点击注册，填邮箱密码
3. 注册后进入工具页，显示"请订阅"
4. 点击购买套餐 → 跳转付款页 → 支付完成自动开通
5. 立即可以使用票据预审功能

## 硅基流动 API Key 说明

客户使用工具时，首次会弹框要求填入硅基流动 API Key。
这个 Key 用于 AI 识别发票，费用由客户自己承担（也可以你统一承担，改代码把 Key 写死在后端）。

## 套餐价格修改

在 `src/server.js` 找到：
```
const PLANS = {
  monthly:   { name: "月付套餐", price: 39900, days: 30  },  // 单位：分
  quarterly: { name: "季付套餐", price: 99900, days: 90  },
  yearly:    { name: "年付套餐", price: 29900, days: 365 },
};
```
修改 price（单位是分，39900 = ¥399）和 days 即可。
