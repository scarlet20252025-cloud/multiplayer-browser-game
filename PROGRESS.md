# 进度记录

## 2026-11-28

- `rea_shanyi.py`：显示列表 + 完整矩阵（a/b/c/d/tx/ty）逐层累乘；489/490 形状解析。
- `rea_shanyi_svg_shapes.py`：直接读 FFDec `shape/<id>.svg`（M/L/H/V/Q/C/Z + matrix），避开手写边记录的坑。
- `rea_shanyi_layers.py`：8 类层合成，全量 shape 导出后 missing 0，包围盒 3066×1202。
- `rea_shanyi_overlay.py`：逐层 bbox + 地罩覆盖率；确认 Level1 真实关卡空间 **2828×600**（BG2），基准图 1927 高是舞台外装饰。
- `rea_shanyi_collide.py`：Ground 多边形按 8px 扫描线拆条带 → **86 个碰撞矩形**（ground 85 + box 1），尺寸 1838×600，原点 -238。
- `adapters/shanyi-native/sim.mjs`：60Hz 物理，跑/摩擦/跳跃/二段跳/AABB。
- 测试：`shanyi-native-sim.test.mjs` 7 项、`shanyi-native-level.test.mjs` 3 项，全部通过。

### 已纠正的错误判断

- 曾以为矩阵平移量级异常（0.0–0.6），实际是带旋转（hasRotate=1, nbits=21），补上旋转后地形才成形。
- 曾以为关卡宽 2903/高 1927，实际那是 FFDec 把舞台外装饰一起渲染；真实舞台 800×600，关卡 2828×600。
