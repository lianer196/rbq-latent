# RBQ Latent 生图插件

配合 [RBQ 生图扩展](https://github.com/TTWParty/SillyTavern-RBQ-Draw) 使用，把 latent.moe 的原生异步生图接口接进酒馆。

## 安装

1. 打开 RBQ 控制台 → 「扩展插件」
2. 仓库源地址填本仓库的 `plugins.json` raw 地址
3. 点「刷新」→ 出现「Latent 生图」→ 点「安装」
4. 刷新页面

## 配置

模式切到「Latent 生图」：

| 字段 | 填什么 |
|---|---|
| 接口地址 | `https://latent.moe` |
| API Key | `lat_sk_...` |

API Key 在 https://latent.moe/dashboard/keys 创建（只显示一次）。

## 参数

- 分辨率：方形 1024² / 竖版 920×1536 / 横版 1536×920
- 步数：8–12
- 采样器：euler / res_multistep / er_sde（+2 个 NAI 写法自动映射）
- 调度器：sgm_uniform / beta / beta57 / linear_quadratic（+2 个 NAI 写法自动映射）
- 种子：-1 随机

「生成测试」页有「参数自检」按钮，可核对面板设置与服务端实际记录是否一致。
