# botcamp

推送到 `main` 时，GitHub Actions（`.github/workflows/deploy-demox.yml`）会跑测试、构建页面，并把静态站点和 `bot` 云函数发布到 Demox 站点 `IVBLF9PE`（https://botcamp.demox.site/）。

仓库需要 Actions secret `DEMOX_TOKEN`（Demox 个人访问令牌）。函数环境变量（管理员密码、项目库令牌）不由这个流程修改。`main` 上还没有应用文件时，工作流会跳过发布，避免用空仓库盖掉线上站点。
