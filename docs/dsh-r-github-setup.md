# DSH-R GitHub 立项向导

本环境没有 GitHub CLI，也没有已登录的 GitHub 凭据；当前仓库的 `origin` 仍指向原项目：

```text
https://github.com/yyh-001/DSH-X.git
```

因此不要执行 `git push origin`。下面按“先在 GitHub 网页建空仓库，再把当前分支推到新仓库”的方式处理。

## 1. 在 GitHub 网页创建仓库

1. 打开 <https://github.com/new>。
2. Repository name 填：

   ```text
   DSH-R
   ```

3. Description 可填：

   ```text
   Secondary development of the DSH-X launcher, focused on remote Linux DSH management.
   ```

4. 选择 Public 或 Private。
5. 不要勾选：
   - Add a README file
   - Add .gitignore
   - Choose a license

   本仓库已有 README、`.gitignore` 和 MIT License，避免 GitHub 生成第一个提交后与本地历史冲突。
6. 点击 **Create repository**。
7. 记下你的仓库地址，例如：

   ```text
   https://github.com/<你的用户名>/DSH-R.git
   ```

## 2. 检查 Git 身份

在 DSH-R 仓库目录执行：

```sh
git config user.name
git config user.email
```

如果为空，先配置：

```sh
git config user.name "你的名字"
git config user.email "你的 GitHub 邮箱"
```

## 3. 建立提交

当前工作区包含 DSH-R 的未提交改动。建议新建 `main` 分支并提交：

```sh
git switch -c main
git add .
git commit -m "feat: DSH-R 远程管理扩展"
```

如果想分开提交，可以按功能拆成多个中文 commit；不要使用 `git reset --hard`。

## 4. 添加 DSH-R 远端

把 `<你的用户名>` 替换成实际 GitHub 用户名：

```sh
git remote add dsh-r https://github.com/<你的用户名>/DSH-R.git
git remote -v
```

此时应看到：

```text
origin  https://github.com/yyh-001/DSH-X.git
dsh-r   https://github.com/<你的用户名>/DSH-R.git
```

## 5. 推送方式 A：HTTPS + GitHub 凭据

执行：

```sh
git push -u dsh-r main
```

GitHub 已不接受账号密码登录 Git。如果要求输入密码，应输入：

- 用户名：GitHub 用户名
- Password：Personal Access Token，不是 GitHub 登录密码

Token 创建入口：

<https://github.com/settings/tokens/new?scopes=repo>

建议使用 Fine-grained token，只给 `DSH-R` 仓库 Contents 读写权限。

## 6. 推送方式 B：SSH 密钥

如果没有 GitHub SSH 密钥，可以生成专用密钥：

```sh
ssh-keygen -t ed25519 -C "你的 GitHub 邮箱" -f ~/.ssh/id_ed25519_dsh_r
cat ~/.ssh/id_ed25519_dsh_r.pub
```

复制输出的公钥，打开：

<https://github.com/settings/ssh/new>

Title 可填 `DSH-R WSL`，Key 粘贴公钥后保存。

在 `~/.ssh/config` 中加入：

```text
Host github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_dsh_r
  IdentitiesOnly yes
```

测试：

```sh
ssh -T git@github.com
```

看到包含 `successfully authenticated` 即可。

然后把远端改为 SSH：

```sh
git remote set-url dsh-r git@github.com:<你的用户名>/DSH-R.git
git push -u dsh-r main
```

## 7. GitHub 仓库设置建议

推送完成后进入 DSH-R 仓库：

1. **Settings → General → Default branch** 确认为 `main`。
2. **Settings → General** 中可勾选：
   - Automatically delete head branches
3. **Settings → Branches** 为 `main` 添加保护：
   - Require a pull request before merging
   - Require status checks to pass before merging
4. **Security → Code security and analysis** 建议：
   - Enable secret scanning
   - Enable dependency scanning

## 8. 发布前注意

- 不要把 `release/release-key.pem`、私钥、token、远端会话 URL 或凭据提交进仓库。
- `release/`、`node_modules/`、`vendor/` 已由 `.gitignore` 排除。
- DSH-R 是 DSH-X 的二次开发项目，需继续保留上游声明与 MIT License。
- 测试安装包不应直接作为正式 Release 发布；正式发布前应单独整理版本号、更新日志、SHA256 和更新清单。
