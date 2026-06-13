# Model Card Portal

本项目从 0 重建，包含：

- 前端录入页
- 后台管理页
- Postgres 项目/职别/报名数据
- n8n `model-card` workflow
- n8n `model-card-project-dir` workflow

## 本地开发

```bash
npm install
npm run dev
```

默认端口：

- 本地开发：`3051`
- 对外站点：`https://yh.ccyinghe.com`

## 已完成

- 新前端录入页
- 新后台管理页
- `model_card_portal` 库初始化代码
- `model-card` n8n 工作流生成与发布脚本
- `model-card-project-dir` n8n 工作流生成与发布脚本
- n8n 已创建并激活：
  - `model-card`：`BwtKicjel3qlhvNI`
  - `model-card-project-dir`：`90BZ5NpXDolGCaEX`

## 部署结构

你当前的服务器容器约定：

- `app.js` 保留，跑在 `3050`
- 本项目新增根目录 [index.js](/Users/chenkewei/Desktop/yhyw/index.js)，加载 [server/index.js](/Users/chenkewei/Desktop/yhyw/server/index.js)，跑在 `3051`
- PM2 使用 [ecosystem.config.cjs](/Users/chenkewei/Desktop/yhyw/ecosystem.config.cjs) 同时启动两个进程
- 如果构建目录里没有 `app.js`，PM2 会只启动 `3051` 的新服务

## 环境变量

参考 [.env.example](/Users/chenkewei/Desktop/yhyw/.env.example)。

关键值：

- `PORT=3051`
- `SITE_URL=https://yh.ccyinghe.com`
- `ALLOWED_ORIGINS=https://yh.ccyinghe.com,http://124.221.88.94:86`
- `DATABASE_URL=postgres://postgres:your-postgres-password@postgres:5432/model_card_portal`
- `PGSSLMODE=disable`
- `N8N_WEBHOOK_URL=https://n8n.ccyinghe.com/webhook/model-card`
- `N8N_PROJECT_DIR_WEBHOOK_URL=https://n8n.ccyinghe.com/webhook/model-card-project-dir`
- `N8N_API_BASE_URL=https://n8n.ccyinghe.com/api/v1`
- `N8N_SOURCE_WORKFLOW_ID=86o21cTCHceBCfE1`
- `N8N_API_KEY=你的 n8n API Key`
- `SUBMISSION_WORKER_CONCURRENCY=2`，后台 PPTX 生成队列并发数
- `ADMIN_PASSWORD=后台强密码，不要使用默认弱口令`

## 前端功能

- 报名项目：后台维护，只读下拉
- 项目介绍：自动显示
- 报名职别：后台维护，只读下拉
- 自我介绍文本：提交给 n8n 用 DeepSeek 预处理
- 联系电话、微信号
- 最佳照片、最佳视频
- 剩余照片最多 2 张
- 剩余视频最多 1 个
- 提交按钮
- 下载按钮

## 后台功能

- 管理员登录
- 项目维护：名称、开始结束日期、介绍
- 职别维护：按项目维护
- 项目职别总览
- 按项目/职别筛选报名清单
- Excel 导出

## n8n

工作流生成脚本：

- [scripts/build-n8n-workflow.js](/Users/chenkewei/Desktop/yhyw/scripts/build-n8n-workflow.js)
- [scripts/build-n8n-project-dir-workflow.js](/Users/chenkewei/Desktop/yhyw/scripts/build-n8n-project-dir-workflow.js)
- [scripts/publish-n8n-workflows.js](/Users/chenkewei/Desktop/yhyw/scripts/publish-n8n-workflows.js)

`model-card` workflow 逻辑：

1. Webhook 接收前端素材。
2. DeepSeek 预处理自我介绍文本。
3. 素材按 `姓名+手机号+职别+上传时间` 重命名。
4. 复制 `pptx制作` 中的 `Code in Python1` 和 `Convert to File1`。
5. 仅修改 `Code in Python1` 的 base64 输出字段名称为 `姓名+手机号+职别+上传时间`。
6. 将 PPTX 写入 `/home/node/.n8n-files/model-card/项目名称/`。
7. 删除中间文件，仅保留 PPTX。

## 数据库初始化

服务启动时自动执行：

- 如果 `model_card_portal` 不存在则尝试创建
- 初始化表：
  - `model_card_admins`
  - `model_card_projects`
  - `model_card_roles`
  - `model_card_submissions`
- 自动创建默认管理员

## 发布命令

生成并发布 n8n 工作流：

```bash
npm run build:n8n
npm run publish:n8n
```

启动服务：

```bash
pm2 start ecosystem.config.cjs
```

Docker 构建：

```bash
docker compose build nodejs
docker compose up -d nodejs
```

## 重要部署注意事项

- `docker-compose.yml` 里不要再把整个 `/usr/src/app` 挂成匿名卷，否则镜像里的新代码会被空目录覆盖。
- 现在的新服务监听 `3051`，Nginx `86` 端口需要反代到 `nodejs:3051`。
- 本地直接运行时，如果本机不在 Docker 私网 `172.20.0.0/24`，`DATABASE_URL=172.20.0.20` 无法连通，这是正常现象。容器内运行才会通。
