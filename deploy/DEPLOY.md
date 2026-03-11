# 部署说明

## 推荐方案

使用 Docker 部署到独立的管理服务器，再由 Nginx 反向代理到公网。

当前项目已经按这个方式准备好：

- 容器镜像：`Dockerfile`
- 容器编排：`compose.yml`
- Nginx 示例：`deploy/nginx.stream-watchdog.conf.example`

## 服务器建议

- Ubuntu 22.04 / 24.04
- 1 到 2 vCPU
- 1 到 2 GB RAM
- 20 GB SSD

如果只是监控几十台推流机，这个配置足够。因为控制台本身不做转码，只做 SSH 巡检、状态存储和网页管理。

## 部署步骤

### 1. 上传项目

建议放到：

```bash
/opt/stream-watchdog
```

### 2. 准备环境变量

创建 `.env`，至少填写：

```env
STREAM_WATCH_CONFIG=./config/watcher.local.json
STREAM_WATCH_RACKNERD_ROOT_PASSWORD=你的推流机 SSH 密码
STREAM_WATCH_WEB_HOST=0.0.0.0
STREAM_WATCH_WEB_PORT=3030
STREAM_WATCH_TRUST_PROXY=true
STREAM_WATCH_COOKIE_SECURE=false
```

如果暂时没有 SMTP，可以先留空。

### 3. 启动容器

```bash
cd /opt/stream-watchdog
docker compose up -d --build
docker compose ps
```

### 4. 查看日志

```bash
docker compose logs -f
```

### 5. 配置 Nginx

新增一个站点，把外部域名转发到 `127.0.0.1:3030`。

当前管理服务器如果已经有别的站点在跑，建议只新增一个新的 `server_name`，不要去改现有站点。

## 关于 HTTPS

如果服务器的 `443` 已经被别的程序占用，比如 `sing-box`，今晚先只上 HTTP，不要强改 `443`。等后面确认现有链路后，再统一做 HTTPS。

## 首次登录

如果是全新数据库，打开网页后先创建超级管理员。

如果数据库为空但项目里带了旧版 JSON 配置，系统会自动导入服务器和直播流配置。导入后你只需要在网页里做账号初始化，不需要再手工写 JSON。

## 迁移建议

- 第一步：先让超级管理员后台稳定跑起来
- 第二步：把更多服务器和直播流迁进数据库
- 第三步：给不同客户发 CDK，让他们各自管理各自的直播
- 第四步：再补 HTTPS、支付、更多告警渠道
