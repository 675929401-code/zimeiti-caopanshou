# 迅虎支付（虎皮椒）API 协议文档

## 1. 发起付款接口

### 请求URL
- 正式环境：`https://api.xunhupay.com/payment/do.html`
- 备用平台：`https://api.dpweixin.com/payment/do.html`
- 传参方式：POST

### 请求参数

| # | 参数名 | 含义 | 类型 | 说明 |
|---|--------|------|------|------|
| 1 | version | API 版本号 | string(24) | 必填。目前为1.1 |
| 2 | appid | APP ID | string(32) | 必填。填写虎皮椒的APPID，不是小程序APPID |
| 3 | trade_order_id | 商户订单号 | string(32) | 必填。确保网站内唯一，只能是数字、大小写字母_-* |
| 4 | total_fee | 订单金额(元) | decimal(18,2) | 必填。单位人民币元 |
| 5 | title | 订单标题 | string(128) | 必填。不超过127字符或42个汉字，不能有表情符号和% |
| 6 | time | 当前时间戳 | int(11) | 必填。PHP示例：time() |
| 7 | notify_url | 通知回调网址 | string(128) | 必填。支付成功后POST通知（SESSION无效，不支持中文域名） |
| 8 | return_url | 跳转网址 | string(128) | 可选。支付成功后浏览器跳转 |
| 9 | callback_url | 商品网址 | string(128) | 可选。用户取消支付后引导跳转重新支付 |
| 10 | plugins | 名称 | string(128) | 可选。识别对接程序或作者 |
| 11 | attach | 备注 | text | 可选。回调时原样返回 |
| 12 | nonce_str | 随机值 | string(32) | 必填。避免缓存+防密钥猜测 |
| 13 | hash | 签名 | string(32) | 必填。见签名算法 |

### 请求返回

| # | 参数名 | 含义 | 类型 | 说明 |
|---|--------|------|------|------|
| 1 | oderid | 订单id | int | 历史遗留错误：返回名称是openid，值是orderid |
| 2 | url_qrcode | 二维码地址(PC端) | string(156) | 5分钟有效，PC端展示扫码支付 |
| 3 | url | 请求url(手机端) | string(155) | 跳转即可，系统自动判断微信/手机端 |
| 4 | errcode | 错误码 | int | |
| 5 | errmsg | 错误信息 | string(8) | |
| 6 | hash | 签名 | string(32) | 数据签名 |

## 2. 支付回调（异步通知）

迅虎服务器 POST 到 notify_url，参数同支付请求 + 以下额外字段：

| 参数名 | 含义 | 说明 |
|--------|------|------|
| status | 支付状态 | OD=成功 |
| transaction_id | 平台交易号 | |
| total_fee | 订单金额 | |
| trade_order_id | 商户订单号 | |
| attach | 备注 | 原样返回 |
| hash | 签名 | |

回调处理成功返回 `success`，失败返回 `fail`。

## 3. 退款接口

### 请求URL
- 正式平台：`https://api.xunhupay.com/payment/refund.html`
- 备用平台：`https://api.dpweixin.com/payment/refund.html`
- 其他平台：`https://api.diypc.com.cn/payment/refund.html`
- 传参方式：POST（curl POST，直接获取JSON返回值）

### 请求参数

| # | 参数名 | 含义 | 类型 | 说明 |
|---|--------|------|------|------|
| 1 | appid | APP ID | string(32) | 必填 |
| 2 | trade_order_id | 商户订单号 | string(32) | 与open_order_id二选一 |
| 3 | open_order_id | 虎皮椒内部订单号 | string(32) | 与trade_order_id二选一 |
| 4 | reason | 退款原因 | string(80) | 可选，微信退款消息中体现 |
| 5 | time | 当前时间戳 | int(11) | 必填 |
| 6 | nonce_str | 随机值 | string(32) | 必填 |
| 7 | hash | 签名 | string(32) | 必填 |

### 请求返回

| # | 参数名 | 含义 | 类型 | 说明 |
|---|--------|------|------|------|
| 1 | trade_order_id | 商户订单号 | string(32) | |
| 2 | transaction_id | 交易号 | string(32) | |
| 3 | out_refund_no | 退款单号 | string(32) | |
| 4 | refund_fee | 退款金额 | decimal(9,2) | |
| 5 | reason | 退款原因 | string(80) | |
| 6 | refund_status | 退款状态 | string(2) | OD已支付，CD已退款，RD退款中，UD退款失败 |
| 7 | refund_time | 退款时间 | string(16) | |
| 8 | errcode | 错误码 | int | |
| 9 | errmsg | 错误信息 | string(8) | |
| 10 | hash | 签名 | string(32) | |

## 4. 签名算法（HASH）

### 步骤

1. 设所有发送或接收到的数据为集合M
2. 将集合M内**非空参数值**的参数按照参数名**ASCII码从小到大排序（字典序）**
3. 使用URL键值对格式拼接成字符串stringA：`key1=value1&key2=value2...`
4. 在stringA最后**直接拼接**APPSECRET（最后一个参数与密钥之间**没有任何连接符**）
5. 对拼接后的字符串进行MD5运算，得到hash值

### 重要规则

- 参数名ASCII码从小到大排序（字典序）
- 参数值为空不参与签名
- 参数名区分大小写
- 验证签名时，hash参数不参与签名
- 必须支持扩展字段（微信接口可能增加字段）

### PHP参考实现

```php
function generate_xh_hash(array $datas, $hashkey) {
    ksort($datas);
    reset($datas);
    $pre = array();
    foreach ($datas as $key => $data) {
        if (is_null($data) || $data === '') { continue; }
        if ($key == 'hash') { continue; }
        $pre[$key] = stripslashes($data);
    }
    $arg = '';
    $qty = count($pre);
    $index = 0;
    foreach ($pre as $key => $val) {
        $arg .= "$key=$val";
        if ($index++ < ($qty - 1)) {
            $arg .= "&";
        }
    }
    return md5($arg . $hashkey);
}
```

### TypeScript等价实现

```typescript
function generateSign(params: Record<string, string>, secret: string): string {
  const sortedKeys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const key of sortedKeys) {
    if (key === 'hash') continue;
    const val = params[key];
    if (val === '' || val === undefined || val === null) continue;
    parts.push(`${key}=${val}`);
  }
  const stringA = parts.join('&');
  const stringSignTemp = stringA + secret;
  return crypto.createHash('md5').update(stringSignTemp, 'utf8').digest('hex').toLowerCase();
}
```

## 5. 网关地址（可配置）

| 用途 | 正式环境 | 备用环境 |
|------|---------|---------|
| 支付 | https://api.xunhupay.com/payment/do.html | https://api.dpweixin.com/payment/do.html |
| 退款 | https://api.xunhupay.com/payment/refund.html | https://api.dpweixin.com/payment/refund.html |

配置优先级：platform_settings 数据库 > 环境变量 > 默认值
