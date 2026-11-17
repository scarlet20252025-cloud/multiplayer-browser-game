# HTML5 权威端输入桥

新增原创适配器 adapters/fireboy-html5/authority-input.mjs，仅针对已加载的第一代 Forest Temple HTML5 游戏，将服务器分配的席位 0/1 分别映射到 level.pers1 / level.pers2。

输入结构：seq（递增输入序号）、moveX（-1/0/1）、buttons（跳跃 bit0）、pressed/released（跳跃边沿）。短按的按下与松开跨两个真实角色 update 消费，ackSeq 仅在全部输入步骤经过真实 update 后递增；网络收包不立即确认。失焦、断线及超时调用 resetSlot 清除输入，新会话传 newEpoch=true。

未修改游戏物理时钟、角色位置或原 game.js 文件；本模块仅在现有角色 update 函数周围包装，并可卸载。其他动作和完整同步尚未接入。单元测试只使用原创模拟角色；用户上传原包实机与两浏览器网络联机还需单独验收。

后续将本接口接入真实 WebSocket 房间、统一暂停命令和状态广播。原游戏及素材不得进入公开仓库。
