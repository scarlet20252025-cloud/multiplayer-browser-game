# AS3 / Ruffle 桥接实验

本目录是一份完全自创的 AS3/AVM2 测试夹具，使用两个不同颜色的方块验证外部输入、权威步进和客户端状态应用。它不包含上传游戏的源码、美术或关卡，也不能代表《森林冰火人》或《闪翼双星》已经改造成功。

## 运行接口

用 Ruffle 加载 `probe.swf`，开启此可信夹具的 `allowScriptAccess`，并传入 `parameters: { mode: "authority" }` 或 `parameters: { mode: "client" }`。通过 `player.ruffle().callExternalInterface(name, ...args)` 调用接口。没有识别到 `mode=authority` 时默认客户端角色。

| 接口 | 参数 | 返回值 |
| --- | --- | --- |
| `netHello` | 无 | `{ protocol: 1, version: "as3-probe-1", role, stepHz: 25, width: 640, height: 360 }` |
| `netStep` | `input0`, `input1` | 权威端推进一步并返回完整快照；客户端调用或输入无效时返回 `null`，状态不变 |
| `netReadState` | 无 | 完整快照的副本 |
| `netReadDisplay` | 无 | `{ protocol, version, tick, players: [{ id, x, y, pointerX, pointerY, pointerScaleX, pointerScaleY }, ...] }` |
| `netApplyState` | 完整快照 | 客户端接受有效且更新的快照时返回 `true`；权威端拒绝；格式无效或旧快照返回 `false` |

`netReadDisplay` 是只读观察接口，直接读取方块和指针的实际 `Shape` 位置、指针的两轴缩放，不读 `players` 模型或推进游戏，用于验证 `drawState` 已将状态应用到显示对象；实际像素画面仍应通过截图检查。

输入格式为 `{ moveX: -1..1, moveY: -1..1, buttons: 0..65535, aimX: 0..1, aimY: 0..1, pressed: 0..65535, released: 0..65535 }`。移动、按钮和边沿掩码缺省为零；可选的 `aimX/aimY` 缺省保持该玩家上一次指针位置，最初为各自方块的归一化坐标。有限的移动值会限制到 `[-1,1]`；非有限数、越界指针和非法按钮/边沿掩码会拒绝。

`pressed/released` 是单次模拟步消费的边沿掩码，和表示当前保持状态的 `buttons` 分开。每名玩家的 `pressedCount/releasedCount` 分别累计“收到非零边沿掩码的步数”，每步每类最多加一；这不声称保留同一个 tick 内任意多次重复点击的次数。即使按下和松开都发生在一个 tick 内、最终 `buttons=0`，只要服务器正确保留两类边沿，AS3 的两个计数也都会增加。调用方消费后必须清空边沿，下一步缺省为零；客户端显示实例只能应用同步的累计计数。

每名玩家独立持有指针，显示为相应颜色的小十字。按钮非零时十字放大，便于验证按钮和指针归属；它未绑定原游戏玩法。逻辑画布固定为 640×360，使用 `StageScaleMode.SHOW_ALL` 等比缩放和 `StageAlign.TOP_LEFT` 左上对齐。宿主页面以实际 `ruffle-player` 显示区域计算 `scale = min(width / 640, height / 360)`；内容区域从左上角起，尺寸为 `640 * scale` 与 `360 * scale`。鼠标坐标扣除该内容区域原点并除以其尺寸，得到归一化的 `aimX/aimY`；右侧或底部多出的留白不属于游戏区域。

快照格式：

```json
{
  "protocol": 1,
  "version": "as3-probe-1",
  "tick": 0,
  "players": [
    { "id": 0, "x": 160, "y": 180, "buttons": 0, "aimX": 0.25, "aimY": 0.5, "pressedCount": 0, "releasedCount": 0 },
    { "id": 1, "x": 480, "y": 180, "buttons": 0, "aimX": 0.75, "aimY": 0.5, "pressedCount": 0, "releasedCount": 0 }
  ]
}
```

每步每轴最多移动 4 像素，中心坐标限制在 `x=16..624`、`y=16..344`。这不是物理引擎。初始 tick 为 0；客户端可以接收第一份 tick 0 快照，之后只接受严格递增的 tick。状态校验全部通过后才一次性应用。

**这里没有自动 `ENTER_FRAME` 游戏模拟、定时器或本地键盘处理。** 必须由权威宿主显式调用 `netStep`。客户端自己调用 `netStep` 不会移动方块。客户端收到的数值快照通过 `netApplyState` 改变本地 AS3 图形对象；网络不必传任何视频或截图。

AS3 中的角色限制仅为夹具的接口检查。真正网络权限仍应由服务器绑定连接和玩家席位，不能信任客户端自称的 role 或 playerId。

## 可复现编译

编译需要 Java。已验证 Apache Flex 编译器为 **4.16.1 build 20171115**，Adobe `playerglobal32_0.swc` 为 **32.0**。目标是 Flash Player 11.1 / SWF 14；源代码仅使用基础 Flash API。

在仓库根目录执行：

```sh
node scripts/build-as3-probe.mjs --download
```

此命令从 Apache 和 Adobe 的官方 HTTPS 地址下载已锁定 SHA-256 的编译依赖，默认保存在 `local/tools/as3-probe/`。需要 `curl` 和 `tar`。这些 SDK 不应提交到 Git。

也可以使用已经下载的工具：

```sh
node scripts/build-as3-probe.mjs \
  --sdk /path/to/apache-flex-sdk-4.16.1-bin \
  --playerglobal /path/to/playerglobal32_0.swc
```

可用 `--tool-dir` 指定下载缓存目录；或使用 `AS3_PROBE_FLEX_SDK`、`AS3_PROBE_PLAYERGLOBAL` 环境变量指定工具。编译脚本不运行 SDK 安装器，也不需要 Adobe AIR、TLF、OSMF 或完整 Flex UI 框架；它直接调用官方 `mxmlc.jar`，仅链接 Flash API 声明。

编译结果：

- `probe.swf`：自创可分发的测试程序。
- `build-evidence.json`：编译器、源文件、产物 SHA-256，SWF 长度校验及 AVM2 / DoABC 结构验证。

编译成功不等于运行测试成功；浏览器中的 ExternalInterface、两实例状态一致性和拒绝非法操作应另行验证。原游戏还需要完整 SWF、资源与游戏专用适配器才能开始对应测试。

## 依赖来源

- Apache Flex 官方编译说明：<https://flex.apache.org/doc/flex/using/flx_compiledeploy_cd.html>
- Apache Flex 官方 SDK：<https://downloads.apache.org/flex/4.16.1/binaries/apache-flex-sdk-4.16.1-bin.tar.gz>
- 官方 MD5：<https://downloads.apache.org/flex/4.16.1/binaries/apache-flex-sdk-4.16.1-bin.tar.gz.md5>
- Adobe Flash API 声明：<https://fpdownload.macromedia.com/get/flashplayer/updaters/32/playerglobal32_0.swc>
- Ruffle 当前公开 JS API：<https://ruffle.rs/js-docs/master/interfaces/Player.PlayerV1.html>

SDK 的官方 MD5 已对照一致，另记录并锁定 SHA-256，见 `build-evidence.json`。Adobe API 声明仅供本地编译，本仓库不再分发 SDK。自创夹具使用本目录 MIT 许可证；该许可证不覆盖第三方工具、上传游戏或其资源。
