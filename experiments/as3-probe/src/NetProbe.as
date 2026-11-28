package {
    import flash.display.Shape;
    import flash.display.Sprite;
    import flash.display.StageAlign;
    import flash.display.StageScaleMode;
    import flash.events.Event;
    import flash.external.ExternalInterface;
    import flash.text.TextField;
    import flash.text.TextFormat;

    /**
     * Original AS3/AVM2 networking fixture. No archived game code or assets.
     * A caller advances the authority explicitly; clients apply snapshots only.
     * There is deliberately no ENTER_FRAME simulation or local keyboard handler.
     */
    [SWF(width="640", height="360", frameRate="25", backgroundColor="#142032")]
    public final class NetProbe extends Sprite {
        private static const VERSION:String = "as3-probe-1";
        private static const WIDTH:int = 640;
        private static const HEIGHT:int = 360;
        private static const SPEED:Number = 4;
        private var role:String = "client";
        private var tick:int = 0;
        private var lastApplied:int = -1;
        private var players:Array;
        private var sprites:Array = [];
        private var pointers:Array = [];
        private var status:TextField;

        public function NetProbe() {
            if (stage) initialize();
            else addEventListener(Event.ADDED_TO_STAGE, onAdded);
        }

        private function onAdded(event:Event):void {
            removeEventListener(Event.ADDED_TO_STAGE, onAdded);
            initialize();
        }

        private function initialize():void {
            stage.scaleMode = StageScaleMode.SHOW_ALL;
            stage.align = StageAlign.TOP_LEFT;
            role = loaderInfo.parameters.mode === "authority" ? "authority" : "client";
            players = [
                {id:0, x:160, y:180, buttons:0, aimX:0.25, aimY:0.5, pressedCount:0, releasedCount:0},
                {id:1, x:480, y:180, buttons:0, aimX:0.75, aimY:0.5, pressedCount:0, releasedCount:0}
            ];
            graphics.beginFill(0x142032);
            graphics.drawRect(0, 0, WIDTH, HEIGHT);
            graphics.endFill();
            graphics.lineStyle(1, 0x33485F);
            for (var gx:int = 40; gx < WIDTH; gx += 40) {
                graphics.moveTo(gx, 50);
                graphics.lineTo(gx, HEIGHT);
            }
            for (var gy:int = 80; gy < HEIGHT; gy += 40) {
                graphics.moveTo(0, gy);
                graphics.lineTo(WIDTH, gy);
            }
            for (var i:int = 0; i < 2; i++) {
                var square:Shape = new Shape();
                square.graphics.lineStyle(2, 0xE6F1FF);
                square.graphics.beginFill(i === 0 ? 0xFF775C : 0x54B5FF);
                square.graphics.drawRect(-12, -12, 24, 24);
                square.graphics.endFill();
                addChild(square);
                sprites.push(square);
            }
            for (var pointerIndex:int = 0; pointerIndex < 2; pointerIndex++) {
                var pointer:Shape = new Shape();
                pointer.graphics.lineStyle(2, pointerIndex === 0 ? 0xFF775C : 0x54B5FF);
                pointer.graphics.moveTo(-8, 0);
                pointer.graphics.lineTo(8, 0);
                pointer.graphics.moveTo(0, -8);
                pointer.graphics.lineTo(0, 8);
                pointer.graphics.drawCircle(0, 0, 4);
                addChild(pointer);
                pointers.push(pointer);
            }
            status = new TextField();
            status.defaultTextFormat = new TextFormat("_sans", 16, 0xE6F1FF);
            status.width = WIDTH - 24;
            status.height = 30;
            status.x = 12;
            status.y = 10;
            status.selectable = false;
            addChild(status);
            drawState();

            if (ExternalInterface.available) {
                ExternalInterface.addCallback("netHello", netHello);
                ExternalInterface.addCallback("netStep", netStep);
                ExternalInterface.addCallback("netReadState", netReadState);
                ExternalInterface.addCallback("netReadDisplay", netReadDisplay);
                ExternalInterface.addCallback("netApplyState", netApplyState);
                trace("AS3_PROBE_READY " + role);
            } else {
                status.appendText(" | ExternalInterface unavailable");
            }
        }

        public function netHello():Object {
            return {protocol:1, version:VERSION, role:role, stepHz:25, width:WIDTH, height:HEIGHT};
        }

        private function normalizeInput(value:Object, previous:Object):Object {
            if (value == null) return {moveX:0, moveY:0, buttons:0, aimX:previous.aimX, aimY:previous.aimY, pressed:0, released:0};
            var mx:Number = value.hasOwnProperty("moveX") ? Number(value.moveX) : 0;
            var my:Number = value.hasOwnProperty("moveY") ? Number(value.moveY) : 0;
            var buttons:Number = value.hasOwnProperty("buttons") ? Number(value.buttons) : 0;
            var aimX:Number = value.hasOwnProperty("aimX") ? Number(value.aimX) : previous.aimX;
            var aimY:Number = value.hasOwnProperty("aimY") ? Number(value.aimY) : previous.aimY;
            var pressed:Number = value.hasOwnProperty("pressed") ? Number(value.pressed) : 0;
            var released:Number = value.hasOwnProperty("released") ? Number(value.released) : 0;
            if (!isFinite(mx) || !isFinite(my) || !isFinite(buttons) || !isFinite(aimX) || !isFinite(aimY) || !isFinite(pressed) || !isFinite(released)) return null;
            if (aimX < 0 || aimX > 1 || aimY < 0 || aimY > 1) return null;
            if (buttons < 0 || buttons > 65535 || buttons !== Math.floor(buttons)) return null;
            if (pressed < 0 || pressed > 65535 || pressed !== Math.floor(pressed)) return null;
            if (released < 0 || released > 65535 || released !== Math.floor(released)) return null;
            return {moveX:Math.max(-1, Math.min(1, mx)), moveY:Math.max(-1, Math.min(1, my)), buttons:int(buttons), aimX:aimX, aimY:aimY, pressed:int(pressed), released:int(released)};
        }

        /** Returns null for clients or invalid input, without changing any state. */
        public function netStep(input0:Object = null, input1:Object = null):Object {
            if (role !== "authority" || tick === int.MAX_VALUE) return null;
            var inputs:Array = [normalizeInput(input0, players[0]), normalizeInput(input1, players[1])];
            if (inputs[0] == null || inputs[1] == null) return null;
            for (var i:int = 0; i < 2; i++) {
                players[i].x = Math.max(16, Math.min(WIDTH - 16, Number(players[i].x) + inputs[i].moveX * SPEED));
                players[i].y = Math.max(16, Math.min(HEIGHT - 16, Number(players[i].y) + inputs[i].moveY * SPEED));
                players[i].buttons = inputs[i].buttons;
                players[i].aimX = inputs[i].aimX;
                players[i].aimY = inputs[i].aimY;
                if (inputs[i].pressed !== 0) players[i].pressedCount++;
                if (inputs[i].released !== 0) players[i].releasedCount++;
            }
            tick++;
            drawState();
            return netReadState();
        }

        public function netReadState():Object {
            return {protocol:1, version:VERSION, tick:tick, players:[
                {id:0, x:Number(players[0].x), y:Number(players[0].y), buttons:int(players[0].buttons), aimX:Number(players[0].aimX), aimY:Number(players[0].aimY), pressedCount:int(players[0].pressedCount), releasedCount:int(players[0].releasedCount)},
                {id:1, x:Number(players[1].x), y:Number(players[1].y), buttons:int(players[1].buttons), aimX:Number(players[1].aimX), aimY:Number(players[1].aimY), pressedCount:int(players[1].pressedCount), releasedCount:int(players[1].releasedCount)}
            ]};
        }

        /** Reads actual display properties; never reads the players state model. */
        public function netReadDisplay():Object {
            var displayPlayers:Array = [];
            for (var i:int = 0; i < 2; i++) {
                displayPlayers.push({
                    id:i,
                    x:Number(sprites[i].x),
                    y:Number(sprites[i].y),
                    pointerX:Number(pointers[i].x),
                    pointerY:Number(pointers[i].y),
                    pointerScaleX:Number(pointers[i].scaleX),
                    pointerScaleY:Number(pointers[i].scaleY)
                });
            }
            return {protocol:1, version:VERSION, tick:tick, players:displayPlayers};
        }

        /** Applies only complete, bounded, newer snapshots. Validation is atomic. */
        public function netApplyState(snapshot:Object):Boolean {
            if (role !== "client" || snapshot == null || snapshot.protocol !== 1 || snapshot.version !== VERSION) return false;
            var nextTick:Number = Number(snapshot.tick);
            if (!isFinite(nextTick) || nextTick !== Math.floor(nextTick) || nextTick < 0 || nextTick > int.MAX_VALUE || nextTick <= lastApplied) return false;
            if (!(snapshot.players is Array) || snapshot.players.length !== 2) return false;
            var next:Array = [];
            for (var i:int = 0; i < 2; i++) {
                var p:Object = snapshot.players[i];
                if (p == null || p.id !== i || !p.hasOwnProperty("x") || !p.hasOwnProperty("y") || !p.hasOwnProperty("buttons") || !p.hasOwnProperty("aimX") || !p.hasOwnProperty("aimY") || !p.hasOwnProperty("pressedCount") || !p.hasOwnProperty("releasedCount")) return false;
                var px:Number = Number(p.x);
                var py:Number = Number(p.y);
                var buttons:Number = Number(p.buttons);
                var aimX:Number = Number(p.aimX);
                var aimY:Number = Number(p.aimY);
                var pressedCount:Number = Number(p.pressedCount);
                var releasedCount:Number = Number(p.releasedCount);
                if (!isFinite(px) || !isFinite(py) || px < 16 || px > WIDTH - 16 || py < 16 || py > HEIGHT - 16) return false;
                if (!isFinite(buttons) || buttons < 0 || buttons > 65535 || buttons !== Math.floor(buttons)) return false;
                if (!isFinite(aimX) || !isFinite(aimY) || aimX < 0 || aimX > 1 || aimY < 0 || aimY > 1) return false;
                if (!isFinite(pressedCount) || pressedCount < 0 || pressedCount > int.MAX_VALUE || pressedCount !== Math.floor(pressedCount)) return false;
                if (!isFinite(releasedCount) || releasedCount < 0 || releasedCount > int.MAX_VALUE || releasedCount !== Math.floor(releasedCount)) return false;
                next.push({id:i, x:px, y:py, buttons:int(buttons), aimX:aimX, aimY:aimY, pressedCount:int(pressedCount), releasedCount:int(releasedCount)});
            }
            players = next;
            tick = int(nextTick);
            lastApplied = tick;
            drawState();
            return true;
        }

        private function drawState():void {
            for (var i:int = 0; i < 2; i++) {
                sprites[i].x = players[i].x;
                sprites[i].y = players[i].y;
                pointers[i].x = players[i].aimX * WIDTH;
                pointers[i].y = players[i].aimY * HEIGHT;
                pointers[i].scaleX = pointers[i].scaleY = players[i].buttons !== 0 ? 1.4 : 1;
            }
            status.text = "AS3 / AVM2 | " + role + " | tick " + tick + " | protocol 1";
        }
    }
}
