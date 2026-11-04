# sandbox/

两层执行环境。**常驻小容器**跑在入口机 Docker 上，负责看文件、跑小命令、定时任务；
**大容器**按需跑在 TKE 超级节点上，负责重活。

## slim/
精简 computer 镜像：`debian:bookworm-slim` + bash/curl/jq/file/procps/busybox，
无桌面、无浏览器，148 MB。PID 1 是 `busybox httpd`，监听 6080 —— 既是
Kubernetes provider 的 readiness 端点，也是目录浏览入口。

实测内存：空转 8 MB 限制可跑（RSS ~390 KiB），下载 20 MB 文件 32 MB 够用，
建议给 64 MB。

构建：`docker build -t botcamp/computer-slim:dev .`（Debian 源需换腾讯镜像，
否则 apt 会卡在几十 KB/s）。

## control/
自研的 lease 控制面（K8s 后端）：`POST /leases` 建 Pod、`/u/<uid>/` 反向代理、
TTL 回收。给"大容器"层用：起 Pod 挂同一个 CFS home，跑完即删。
实测冷启 32–45 秒（超级节点偶有 2.5 分钟长尾）。
