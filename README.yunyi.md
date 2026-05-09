# 云逸生图部署说明

## Docker Compose

1. 复制环境变量：

```bash
cp .env.example .env
```

2. 编辑 `.env`：

```bash
YUNYI_ADMIN_PASSWORD=你的后台密码
BACKGRACE_API_KEY=你的BackGraceKey
YUNYI_PURCHASE_URL=你的卡网购买链接
```

3. 启动：

```bash
docker compose up -d --build
```

4. 访问：

```text
前台：http://服务器IP:3000/
后台：http://服务器IP:3000/admin
```

## 卡密规则

卡密格式为：

```text
YunYi-XXXX-XXXX-XXXX-XXXX
```

字符使用大写字母和数字，并避开容易混淆的 `0/O/1/I/L`。

后台可以批量生成卡密、设置每张卡次数、导出后放到你的卡网出售。

## 数据持久化

SQLite 数据库保存在：

```text
./data/yunyi.sqlite
```

Docker Compose 已把它挂载到宿主机 `./data`，重启容器不会丢。
