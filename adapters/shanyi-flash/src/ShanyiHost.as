package
{
    import flash.display.DisplayObject;
    import flash.display.DisplayObjectContainer;
    import flash.display.InteractiveObject;
    import flash.display.Loader;
    import flash.display.MovieClip;
    import flash.display.SimpleButton;
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.events.KeyboardEvent;
    import flash.events.MouseEvent;
    import flash.events.TimerEvent;
    import flash.external.ExternalInterface;
    import flash.geom.ColorTransform;
    import flash.geom.Point;
    import flash.geom.Rectangle;
    import flash.net.URLRequest;
    import flash.system.ApplicationDomain;
    import flash.system.LoaderContext;
    import flash.utils.Timer;
    import flash.utils.getQualifiedClassName;

    [SWF(width="800", height="600", frameRate="30", backgroundColor="#202020")]
    public class ShanyiHost extends Sprite
    {
        private var loader:Loader;
        private var main:DisplayObject;
        private var tintTimer:Timer;
        private var stageClicks:int = 0;
        private var startClicks:int = 0;
        private var startWired:Boolean = false;
        private var lastClickTarget:String = "";
        private var relayGuard:Boolean = false;
        private var keyRelayGuard:Boolean = false;

        public function ShanyiHost()
        {
            super();
            var game:String = loaderInfo.parameters.game;
            if (game == null || game == "")
            {
                game = "/game/core_4_abc.swf";
            }
            loader = new Loader();
            loader.contentLoaderInfo.addEventListener(Event.COMPLETE, onLoaded);
            loader.load(new URLRequest(game), new LoaderContext(false, ApplicationDomain.currentDomain));
            addEventListener(Event.ADDED_TO_STAGE, onAdded);
        }

        private function onAdded(event:Event):void
        {
            removeEventListener(Event.ADDED_TO_STAGE, onAdded);
            if (ExternalInterface.available)
            {
                ExternalInterface.addCallback("shanyiKey", injectKey);
                ExternalInterface.addCallback("shanyiReady", isReady);
                ExternalInterface.addCallback("shanyiFrame", gameFrame);
                ExternalInterface.addCallback("shanyiProbe", probePoint);
                ExternalInterface.addCallback("shanyiStart", triggerStart);
                ExternalInterface.addCallback("shanyiStats", eventStats);
                ExternalInterface.addCallback("shanyiButtonRect", buttonRect);
                ExternalInterface.addCallback("shanyiScan", scanButtons);
                ExternalInterface.addCallback("shanyiButtons", listButtons);
                ExternalInterface.addCallback("shanyiPage", currentPageClass);
                ExternalInterface.addCallback("shanyiClickAt", clickAt);
                ExternalInterface.addCallback("shanyiKeys", keysDownReport);
                ExternalInterface.addCallback("shanyiHeroes", heroesReport);
                ExternalInterface.addCallback("shanyiLevel", levelReport);
                ExternalInterface.addCallback("shanyiHeroState", heroState);
                ExternalInterface.addCallback("shanyiApplyHero", applyHero);
                ExternalInterface.addCallback("shanyiPaused", pauseReport);
            }
        }

        private function onLoaded(event:Event):void
        {
            addChild(loader);
            stage.addEventListener(MouseEvent.CLICK, onStageClick, true);
            stage.addEventListener(KeyboardEvent.KEY_DOWN, onNativeKey, true);
            stage.addEventListener(KeyboardEvent.KEY_UP, onNativeKey, true);
            tintTimer = new Timer(250);
            tintTimer.addEventListener(TimerEvent.TIMER, fixIntroTint);
            tintTimer.start();
        }

        private function onStageClick(event:MouseEvent):void
        {
            stageClicks++;
            var cursor:DisplayObject = event.target as DisplayObject;
            var chain:Array = [];
            var depth:int = 0;
            while (cursor != null && depth < 6)
            {
                var label:String = getQualifiedClassName(cursor);
                if (cursor.name != null && cursor.name != "")
                {
                    label += "#" + cursor.name;
                }
                chain.push(label);
                cursor = cursor.parent;
                depth++;
            }
            lastClickTarget = chain.join(" < ");

            var target:InteractiveObject = event.target as InteractiveObject;
            if (!relayGuard && target != null)
            {
                relayGuard = true;
                try
                {
                    var local:Point = target.globalToLocal(new Point(event.stageX, event.stageY));
                    target.dispatchEvent(new MouseEvent(MouseEvent.CLICK, true, false, local.x, local.y));
                }
                finally
                {
                    relayGuard = false;
                }
            }
        }

        private function fixIntroTint(event:TimerEvent):void
        {
            if (main == null)
            {
                main = findMain(loader.content);
            }
            if (main != null)
            {
                var ct:ColorTransform = main.transform.colorTransform;
                if (ct.redMultiplier < 0.99 || ct.greenMultiplier < 0.99 || ct.blueMultiplier < 0.99)
                {
                    main.transform.colorTransform = new ColorTransform(1, 1, 1, ct.alphaMultiplier, 0, 0, 0, ct.alphaOffset);
                }
            }
        }

        private function findMain(object:DisplayObject):DisplayObject
        {
            if (object == null)
            {
                return null;
            }
            if (getQualifiedClassName(object) == "Main")
            {
                return object;
            }
            var container:DisplayObjectContainer = object as DisplayObjectContainer;
            if (container != null)
            {
                for (var i:int = 0; i < container.numChildren; i++)
                {
                    var found:DisplayObject = findMain(container.getChildAt(i));
                    if (found != null)
                    {
                        return found;
                    }
                }
            }
            return null;
        }

        private function onNativeKey(event:KeyboardEvent):void
        {
            if (keyRelayGuard || stage == null)
            {
                return;
            }
            keyRelayGuard = true;
            try
            {
                stage.dispatchEvent(new KeyboardEvent(event.type, true, false, 0, event.keyCode));
            }
            finally
            {
                keyRelayGuard = false;
            }
        }

        private function injectKey(code:int, down:Boolean):Boolean
        {
            if (stage == null)
            {
                return false;
            }
            var type:String = down ? KeyboardEvent.KEY_DOWN : KeyboardEvent.KEY_UP;
            keyRelayGuard = true;
            try
            {
                stage.dispatchEvent(new KeyboardEvent(type, true, false, 0, code));
            }
            finally
            {
                keyRelayGuard = false;
            }
            return true;
        }

        private function isReady():Boolean
        {
            return main != null;
        }

        private function gameFrame():int
        {
            var clip:MovieClip = main as MovieClip;
            return clip == null ? -1 : clip.currentFrame;
        }

        private function probePoint(x:Number, y:Number):String
        {
            if (stage == null)
            {
                return "no-stage";
            }
            var hits:Array = stage.getObjectsUnderPoint(new Point(x, y));
            var parts:Array = [];
            for (var i:int = hits.length - 1; i >= 0; i--)
            {
                var object:DisplayObject = hits[i] as DisplayObject;
                if (object == null)
                {
                    continue;
                }
                var chain:Array = [];
                var cursor:DisplayObject = object;
                var depth:int = 0;
                while (cursor != null && depth < 8)
                {
                    var label:String = getQualifiedClassName(cursor);
                    if (cursor.name != null && cursor.name != "")
                    {
                        label += "#" + cursor.name;
                    }
                    chain.push(label);
                    cursor = cursor.parent;
                    depth++;
                }
                parts.push(chain.join(" < "));
            }
            return parts.join("\n---\n");
        }

        private function findPage(object:DisplayObject):DisplayObject
        {
            if (object == null)
            {
                return null;
            }
            if (getQualifiedClassName(object).indexOf("MainPage") >= 0)
            {
                return object;
            }
            var container:DisplayObjectContainer = object as DisplayObjectContainer;
            if (container != null)
            {
                for (var i:int = 0; i < container.numChildren; i++)
                {
                    var found:DisplayObject = findPage(container.getChildAt(i));
                    if (found != null)
                    {
                        return found;
                    }
                }
            }
            return null;
        }

        private function wireStartButton():void
        {
            if (startWired || main == null)
            {
                return;
            }
            var page:DisplayObject = findPage(main);
            if (page == null)
            {
                return;
            }
            var button:Object = null;
            try
            {
                button = page["startButton"];
            }
            catch (error:Error)
            {
                return;
            }
            if (button is InteractiveObject)
            {
                InteractiveObject(button).addEventListener(MouseEvent.CLICK, onStartClick);
                startWired = true;
            }
        }

        private function onStartClick(event:MouseEvent):void
        {
            startClicks++;
        }

        private function triggerStart():String
        {
            if (main == null)
            {
                return "no-main";
            }
            var page:DisplayObject = findPage(main);
            if (page == null)
            {
                return "no-page";
            }
            var button:Object = null;
            try
            {
                button = page["startButton"];
            }
            catch (error2:Error)
            {
                return "no-startButton:" + error2.message;
            }
            if (button == null)
            {
                return "startButton-null page=" + getQualifiedClassName(page);
            }
            try
            {
                button.dispatchEvent(new MouseEvent(MouseEvent.CLICK, true));
            }
            catch (error3:Error)
            {
                return "dispatch-failed:" + error3.message;
            }
            return "clicked page=" + getQualifiedClassName(page) + " btn=" + getQualifiedClassName(button as Object);
        }

        private function eventStats():String
        {
            wireStartButton();
            return "stageClicks=" + stageClicks + " startClicks=" + startClicks + " wired=" + startWired
                + " lastTarget=" + lastClickTarget;
        }

        private function keysDownReport():String
        {
            try
            {
                var inputClass:Class = ApplicationDomain.currentDomain.getDefinition("misc.Input") as Class;
                if (inputClass == null)
                {
                    return "no-input";
                }
                var down:Object = inputClass["keysDown"];
                if (down == null)
                {
                    return "no-keysDown";
                }
                var parts:Array = [];
                for (var code:Object in down)
                {
                    parts.push(String(code));
                }
                parts.sort();
                return parts.length == 0 ? "none" : parts.join(",");
            }
            catch (error:Error)
            {
                return "error:" + error.message;
            }
            return "unreachable";
        }

        private function heroesReport():String
        {
            var parts:Array = [];
            collectHeroes(loader.content, parts, 0);
            return parts.length == 0 ? "none" : parts.join("|");
        }

        private function levelReport():String
        {
            var level:Object = findLevelObject(loader.content, 0);
            if (level == null)
            {
                return "no-level";
            }
            return getQualifiedClassName(level as Object) + " fire=" + heroInfo(level["fireMan"])
                + " ice=" + heroInfo(level["iceMan"]);
        }

        private function findLevelObject(object:DisplayObject, depth:int):Object
        {
            if (object == null || depth > 24)
            {
                return null;
            }
            try
            {
                var fire:Object = object["fireMan"];
                var ice:Object = object["iceMan"];
                if (fire != null && ice != null)
                {
                    return object;
                }
            }
            catch (error:Error)
            {
            }
            var container:DisplayObjectContainer = object as DisplayObjectContainer;
            if (container == null)
            {
                return null;
            }
            for (var i:int = 0; i < container.numChildren; i++)
            {
                var found:Object = findLevelObject(container.getChildAt(i), depth + 1);
                if (found != null)
                {
                    return found;
                }
            }
            return null;
        }

        private function heroInfo(hero:Object):String
        {
            if (!(hero is DisplayObject))
            {
                return "none";
            }
            var sprite:DisplayObject = hero as DisplayObject;
            var point:Point = sprite.localToGlobal(new Point(0, 0));
            return getQualifiedClassName(sprite) + "@" + Math.round(point.x) + "," + Math.round(point.y)
                + " v=" + sprite.visible;
        }

        private function pauseReport():String
        {
            try
            {
                var level:Object = findLevelObject(loader.content, 0);
                if (level == null)
                {
                    return "no-level";
                }
                var overlay:Boolean = false;
                if (main != null)
                {
                    var gpmc:Object = main["gamePauseMC"];
                    if (gpmc is DisplayObject)
                    {
                        overlay = DisplayObject(gpmc).parent != null;
                    }
                }
                return "paused=" + Boolean(level["paused"]) + " overlay=" + overlay;
            }
            catch (error:Error)
            {
                return "error:" + error.message;
            }
            return "unreachable";
        }

        private function heroForSeat(seat:int):Object
        {
            var level:Object = findLevelObject(loader.content, 0);
            if (level == null)
            {
                return null;
            }
            return seat == 1 ? level["iceMan"] : level["fireMan"];
        }

        private function heroState(seat:int):String
        {
            try
            {
                var hero:Object = heroForSeat(seat);
                if (!(hero is DisplayObject))
                {
                    return "none";
                }
                var sprite:DisplayObject = hero as DisplayObject;
                var vx:Number = 0;
                var vy:Number = 0;
                var body:Object = hero["b2body"];
                if (body != null)
                {
                    var velocity:Object = body.GetLinearVelocity();
                    if (velocity != null)
                    {
                        vx = Number(velocity.x);
                        vy = Number(velocity.y);
                    }
                }
                return sprite.x + "," + sprite.y + "," + vx + "," + vy;
            }
            catch (error:Error)
            {
                return "error:" + error.message;
            }
            return "unreachable";
        }

        private function applyHero(seat:int, x:Number, y:Number, vx:Number, vy:Number):String
        {
            try
            {
                var hero:Object = heroForSeat(seat);
                if (!(hero is DisplayObject))
                {
                    return "no-hero";
                }
                var sprite:DisplayObject = hero as DisplayObject;
                var dx:Number = x - sprite.x;
                var dy:Number = y - sprite.y;
                if (isNaN(dx) || isNaN(dy))
                {
                    return "nan";
                }
                if (Math.abs(dx) < 1 && Math.abs(dy) < 1)
                {
                    return "close";
                }
                // A peer that is still in another room/area reports coordinates
                // in a different camera space. Teleporting the local body there
                // makes the local camera chase an unreachable point and can
                // leave the player staring at empty background. Keep the local
                // simulation stable until both clients are in the same area.
                if (Math.abs(dx) > 180 || Math.abs(dy) > 180)
                {
                    return "skip-far";
                }
                var body:Object = hero["b2body"];
                if (body == null)
                {
                    return "no-body";
                }
                var world:Object = hero["world"];
                var scale:Number = world == null ? 32 : Number(world["scale"]);
                if (!(scale > 0))
                {
                    scale = 32;
                }
                var v2Class:Class = ApplicationDomain.currentDomain.getDefinition("Box2DAS.Common.V2") as Class;
                if (v2Class == null)
                {
                    return "no-v2";
                }
                var point:Object = body.GetPosition();
                body.SetTransform(new v2Class(point.x + dx / scale, point.y + dy / scale), body.GetAngle());
                if (!isNaN(vx) && !isNaN(vy))
                {
                    body.SetLinearVelocity(new v2Class(vx, vy));
                }
                return "moved " + Math.round(dx) + "," + Math.round(dy);
            }
            catch (error:Error)
            {
                return "error:" + error.message;
            }
            return "unreachable";
        }

        private function collectHeroes(object:DisplayObject, output:Array, depth:int):void
        {
            if (object == null || depth > 24 || output.length > 16)
            {
                return;
            }
            var className:String = getQualifiedClassName(object);
            if (className.indexOf("ManHero") >= 0)
            {
                var point:Point = object.localToGlobal(new Point(0, 0));
                output.push(className + "@" + Math.round(point.x) + "," + Math.round(point.y));
            }
            var container:DisplayObjectContainer = object as DisplayObjectContainer;
            if (container == null)
            {
                return;
            }
            for (var i:int = 0; i < container.numChildren; i++)
            {
                collectHeroes(container.getChildAt(i), output, depth + 1);
            }
        }

        private function clickAt(x:Number, y:Number):String
        {
            if (stage == null)
            {
                return "no-stage";
            }
            var buttons:Array = [];
            collectButtons(main, buttons, 0);
            var chosen:InteractiveObject = null;
            for (var i:int = 0; i < buttons.length; i++)
            {
                var candidate:DisplayObject = buttons[i] as DisplayObject;
                if (candidate == null || !candidate.visible || candidate.stage == null)
                {
                    continue;
                }
                if (candidate.hitTestPoint(x, y, true))
                {
                    var candidateInteractive:InteractiveObject = candidate as InteractiveObject;
                    if (candidateInteractive != null && candidateInteractive.mouseEnabled)
                    {
                        chosen = candidateInteractive;
                    }
                }
            }
            if (chosen == null)
            {
                relayGuard = true;
                try
                {
                    stage.dispatchEvent(new MouseEvent(MouseEvent.CLICK,true,false,x,y));
                }
                finally
                {
                    relayGuard = false;
                }
                return "stage-click";
            }
            var local:Point = chosen.globalToLocal(new Point(x, y));
            relayGuard = true;
            try
            {
                chosen.dispatchEvent(new MouseEvent(MouseEvent.CLICK, true, false, local.x, local.y));
            }
            finally
            {
                relayGuard = false;
            }
            return "clicked " + getQualifiedClassName(chosen) + "#" + chosen.name;
        }

        private function currentPageClass():String
        {
            if (main == null)
            {
                return "no-main";
            }
            var layers:DisplayObjectContainer = main as DisplayObjectContainer;
            if (layers == null)
            {
                return "no-layers";
            }
            for (var i:int = 0; i < layers.numChildren; i++)
            {
                var layer:DisplayObjectContainer = layers.getChildAt(i) as DisplayObjectContainer;
                if (layer == null)
                {
                    continue;
                }
                for (var j:int = 0; j < layer.numChildren; j++)
                {
                    var child:DisplayObject = layer.getChildAt(j);
                    var className:String = getQualifiedClassName(child);
                    if (className.indexOf("Page") >= 0 || className.indexOf("Level") >= 0)
                    {
                        return className;
                    }
                }
            }
            return "no-pages";
        }

        private function listButtons():String
        {
            var found:Array = [];
            collectButtons(main, found, 0);
            var parts:Array = [];
            for (var i:int = 0; i < found.length; i++)
            {
                var button:DisplayObject = found[i] as DisplayObject;
                if (button == null)
                {
                    continue;
                }
                var bounds:Rectangle = button.getBounds(stage);
                var parentLabel:String = button.parent == null ? "?" : getQualifiedClassName(button.parent);
                var hasClick:Boolean = button is InteractiveObject && InteractiveObject(button).hasEventListener(MouseEvent.CLICK);
                parts.push(getQualifiedClassName(button) + "#" + button.name + " @" + Math.round(bounds.x) + "," + Math.round(bounds.y)
                    + " " + Math.round(bounds.width) + "x" + Math.round(bounds.height)
                    + " vis=" + button.visible + " click=" + hasClick + " parent=" + parentLabel);
            }
            return parts.length == 0 ? "none" : parts.join("\n");
        }

        private function collectButtons(object:DisplayObject, output:Array, depth:int):void
        {
            if (object == null || depth > 12)
            {
                return;
            }
            var className:String = getQualifiedClassName(object);
            if (className.indexOf("SimpleButton") >= 0)
            {
                output.push(object);
                return;
            }
            var container:DisplayObjectContainer = object as DisplayObjectContainer;
            if (container != null)
            {
                for (var i:int = 0; i < container.numChildren; i++)
                {
                    collectButtons(container.getChildAt(i), output, depth + 1);
                }
            }
        }

        private function scanButtons():String
        {
            if (stage == null)
            {
                return "no-stage";
            }
            var hitsByType:Object = {};
            var columns:int = 0;
            var minX:Number = 800;
            var maxX:Number = 0;
            var minY:Number = 600;
            var maxY:Number = 0;
            for (var sx:Number = 350; sx <= 750; sx += 10)
            {
                for (var sy:Number = 380; sy <= 500; sy += 5)
                {
                    var hits:Array = stage.getObjectsUnderPoint(new Point(sx, sy));
                    for (var i:int = 0; i < hits.length; i++)
                    {
                        var cursor:DisplayObject = hits[i] as DisplayObject;
                        var depth:int = 0;
                        while (cursor != null && depth < 10)
                        {
                            var className:String = getQualifiedClassName(cursor);
                            if (className.indexOf("SimpleButton") >= 0 || className.indexOf("Btn") >= 0)
                            {
                                if (hitsByType[className] == null)
                                {
                                    hitsByType[className] = { minX: sx, maxX: sx, minY: sy, maxY: sy, count: 0 };
                                }
                                var entry:Object = hitsByType[className];
                                entry.minX = Math.min(entry.minX, sx);
                                entry.maxX = Math.max(entry.maxX, sx);
                                entry.minY = Math.min(entry.minY, sy);
                                entry.maxY = Math.max(entry.maxY, sy);
                                entry.count++;
                            }
                            cursor = cursor.parent;
                            depth++;
                        }
                    }
                }
            }
            var parts:Array = [];
            for (var key:String in hitsByType)
            {
                var rec:Object = hitsByType[key];
                parts.push(key + " x:" + rec.minX + "-" + rec.maxX + " y:" + rec.minY + "-" + rec.maxY + " n=" + rec.count);
            }
            return parts.length == 0 ? "no-buttons" : parts.join("\n");
        }

        private function buttonRect():String
        {
            if (main == null)
            {
                return "no-main";
            }
            var page:DisplayObject = findPage(main);
            if (page == null)
            {
                return "no-page";
            }
            var button:Object = null;
            try
            {
                button = page["startButton"];
            }
            catch (error:Error)
            {
                return "no-startButton";
            }
            if (!(button is DisplayObject))
            {
                return "button-not-displayobject";
            }
            var bounds:Rectangle = DisplayObject(button).getBounds(stage);
            var ct:ColorTransform = DisplayObject(button).transform.colorTransform;
            var interactive:InteractiveObject = button as InteractiveObject;
            var hasClick:Boolean = interactive != null ? interactive.hasEventListener(MouseEvent.CLICK) : false;
            var enabledValue:Boolean = button is SimpleButton ? SimpleButton(button).enabled : false;
            var mouseEnabledValue:Boolean = interactive != null ? interactive.mouseEnabled : false;
            var hitCenter:Boolean = DisplayObject(button).hitTestPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, true);
            return "x=" + bounds.x + " y=" + bounds.y + " w=" + bounds.width + " h=" + bounds.height
                + " vis=" + DisplayObject(button).visible + " alpha=" + DisplayObject(button).alpha
                + " ct=" + ct.redMultiplier + "/" + ct.greenMultiplier + "/" + ct.blueMultiplier
                + " hasClick=" + hasClick + " enabled=" + enabledValue + " mouseEnabled=" + mouseEnabledValue
                + " hitCenter=" + hitCenter + " pageStage=" + (DisplayObject(page).stage != null);
        }
    }
}
