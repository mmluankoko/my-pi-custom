# timing — pi-timing 本地修改版

> **出处**：基于 [pi-timing](https://github.com/adamcjm/pi-timing) **v1.3.0**（作者 adamcjm，MIT License，以 `pi-timing` 的 `package.json` 声明为准）。
>
> 本仓库收录此文件**仅为个人多机同步**，不是 fork、未重命名项目。功能与荣誉属于上游作者；本目录下的修改同样以 MIT 发布。

## 与上游 v1.3.0 的差异（本地修改）

仅一处 UI 精简：

- **widget 行首移除「会话跨度」（session span）显示**，只保留「累计活跃（含轮数）」。
  - 删除了 `spanMs()` 的行内定义与行首拼接，行首由
    `⏱ 会话跨度 Xm… · 累计活跃 Ym (N轮)`
    变为
    `⏱ 累计活跃 Ym (N轮)`
  - 其余逻辑（生成 / 工具计时、逐回复标注行、`/timing` 命令、多语言、快照持久化）与上游一致。

## 安装

```bash
cp -r extensions/timing ~/.pi/agent/extensions/
```

重启 pi（或 `/reload`）生效。命令：`/timing`、`/timing list`、`/timing lang zh|en|auto`、`/timing lines on|off`。

## 上游更新

如需跟随上游更新：从 https://github.com/adamcjm/pi-timing 拉取新版 `extensions/timing/index.ts` 后，重新套用上面的「移除会话跨度」修改即可（改动很小，对照本目录文件即可完成）。
