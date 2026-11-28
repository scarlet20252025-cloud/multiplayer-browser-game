# Tiled 地图机关类型检查（离线，不提交原游戏资产）

`scripts/tiled-objects.mjs` 读取私人 Tiled JSON 关卡和私人 `Objects.json` tileset，只生成机关类型、gid 偏移、基础坐标、分组等原创诊断 JSON。不同关卡的 `firstgid` 可能变化，同一个全局 `gid=26` 并不永远代表相同机关。

示例：
```bash
node scripts/tiled-objects.mjs \
  --map local/private/html5-online/games/1-forest-temple/data/forest/levels/forest_27.json \
  --objects-tileset local/private/html5-online/games/shared-assets/assets/tilemaps/tilesets/Objects.json \
  --out local/stage27-object-types.json
```

针对上传的原版文件，第 27 关 Objects tileset 的 `firstgid=26`，所以 `gid=26` 是相对 tile 0 的 **pusher（按钮）**。如果另一关的 `firstgid=24`，那么 `gid=26` 是相对 tile 2 的 **lever（杠杆）**。类型需要用 `gid-firstgid` 再读取 tile 的 type，不能静态把全局 gid 硬编码为“杠杆”。

本工具不修改或运行原游戏，`gameplayVerified=false`。测试使用原创夹具，不把被检原包图片、关卡 JSON、SWF 或源码提交到公开 GitHub。真正交互验收见 `docs/HTML5_MECHANISM_TEST.md`。
