package {
    import flash.display.DisplayObjectContainer;
    import flash.display.Loader;
    import flash.display.Sprite;
    import flash.display.StageQuality;
    import flash.events.Event;
    import flash.events.IOErrorEvent;
    import flash.events.KeyboardEvent;
    import flash.net.URLLoader;
    import flash.net.URLLoaderDataFormat;
    import flash.net.URLRequest;
    import flash.system.ApplicationDomain;
    import flash.system.LoaderContext;
    import flash.ui.Keyboard;
    import flash.utils.ByteArray;
    import flash.utils.getQualifiedClassName;

    [SWF(width="700", height="510", frameRate="40", backgroundColor="#15181c")]
    public final class BombItSnapshotProbe extends Sprite {
        private static const UI_MANAGER:String = "zlong.bombIt.ui.UIManager";
        private static const CONTROLLER_FIELDS:Array = [
            "gameTime", "pastTime", "pastSecond", "propBornTime", "currentLevel", "isGameOver"
        ];
        private static const ROBOT_FIELDS:Array = [
            "robotID", "currentX", "currentY", "bombPow", "allowBomb", "speed"
        ];
        private static const PLAYER_FIELDS:Array = ["life", "totalPoint", "boxPoint", "killPoint"];
        private static const SEAT_KEYS:Array = [
            [Keyboard.A, Keyboard.D, Keyboard.W, Keyboard.S, Keyboard.SPACE],
            [Keyboard.LEFT, Keyboard.RIGHT, Keyboard.UP, Keyboard.DOWN, Keyboard.ENTER],
            [Keyboard.J, Keyboard.L, Keyboard.U, Keyboard.K, Keyboard.O],
            [Keyboard.F, Keyboard.H, Keyboard.T, Keyboard.G, Keyboard.Y]
        ];
        private static const BOMB_FIELDS:Array = [
            "xPos", "yPos", "bombPow", "blastTime", "leavingsTime", "possibleBlastTime"
        ];

        private const movie:Loader = new Loader();
        private const domain:ApplicationDomain = new ApplicationDomain(ApplicationDomain.currentDomain);
        private const download:URLLoader = new URLLoader();
        private var originalBytes:ByteArray;
        private var seatCount:int = 2;
        private var outfits:Array;
        private var mapId:String;
        private var modeId:String;
        private var seatsReady:Boolean;

        public function BombItSnapshotProbe() {
            var requestedSeats:String = loaderInfo.parameters.seats;
            if (requestedSeats == "3" || requestedSeats == "4") seatCount = int(requestedSeats);
            var requestedOutfits:String = loaderInfo.parameters.outfits;
            outfits = requestedOutfits ? JSON.parse(requestedOutfits) as Array : [];
            mapId = loaderInfo.parameters.mapId || "FashionShop";
            modeId = loaderInfo.parameters.modeId || "kill";
            addChild(movie);
            stage.addEventListener(KeyboardEvent.KEY_DOWN, onKey);
            movie.contentLoaderInfo.addEventListener(Event.COMPLETE, onMovieReady);
            movie.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, onMovieError);
            download.dataFormat = URLLoaderDataFormat.BINARY;
            download.addEventListener(Event.COMPLETE, onBytesReady);
            download.addEventListener(IOErrorEvent.IO_ERROR, onMovieError);
            var source:String = loaderInfo.parameters.originalUrl;
            if (!source) source = "bomb-it-7.swf";
            if (source == "bomb-it-7.swf" || source.indexOf("blob:") == 0) {
                download.load(new URLRequest(source));
            } else {
                trace("BOMB_IT_PROBE_ERROR unsupported original URL");
            }
        }

        private function onBytesReady(event:Event):void {
            originalBytes = download.data as ByteArray;
            trace("BOMB_IT_PROBE_FETCHED " + originalBytes.length);
        }

        private function onMovieReady(event:Event):void {
            trace("BOMB_IT_PROBE_READY " + getQualifiedClassName(movie.content));
        }

        private function onMovieError(event:IOErrorEvent):void {
            trace("BOMB_IT_PROBE_ERROR " + event.text);
        }

        private function onKey(event:KeyboardEvent):void {
            if (event.keyCode == Keyboard.F8 && originalBytes) {
                movie.loadBytes(originalBytes, new LoaderContext(false, domain));
                originalBytes = null;
                return;
            }
            if (event.keyCode == Keyboard.F7 || event.keyCode == Keyboard.F6) {
                try {
                    if (!domain.hasDefinition(UI_MANAGER)) return;
                    var managerType:Object = domain.getDefinition(UI_MANAGER);
                    var ui:Object = managerType.instance;
                    if (!ui) return;
                    if (event.keyCode == Keyboard.F7 && !ui.game && ui.uiContainer.numChildren > 0) {
                        startDuel(ui);
                        trace("BOMB_IT_PROBE_DUEL_REQUESTED");
                    } else if (event.keyCode == Keyboard.F6 && ui.game && ui.game.view) {
                        if (!seatsReady) prepareHumanSeats(ui.game);
                        stage.quality = StageQuality.LOW;
                        ui.game.view.gameResume();
                        trace("BOMB_IT_PROBE_DUEL_RESUMED");
                    }
                } catch (duelError:Error) {
                    trace("BOMB_IT_PROBE_ERROR " + duelError.message);
                }
                return;
            }
            if (event.keyCode != Keyboard.F9) return;
            try {
                if (!domain.hasDefinition(UI_MANAGER)) {
                    trace("BOMB_IT_PROBE_WAITING class");
                    return;
                }
                var uiType:Object = domain.getDefinition(UI_MANAGER);
                var controller:Object = uiType.instance ? uiType.instance.game : null;
                if (!controller) {
                    trace("BOMB_IT_PROBE_WAITING controller");
                    return;
                }
                trace("BOMB_IT_PROBE_STATE " + JSON.stringify([
                    stage.frameRate,
                    fields(controller, CONTROLLER_FIELDS).concat(fields(controller.gameEngine, ["gamePause"])),
                    actors(controller.robots, ROBOT_FIELDS, true),
                    playerStates(controller.players),
                    controller.deadRobots ? controller.deadRobots.length : 0,
                    grid(controller.map),
                    hasPauseOverlay(uiType.instance.uiContainer),
                    [domain.getDefinition("DataCenter").currentStage, controller.gameMode]
                ]));
            } catch (error:Error) {
                trace("BOMB_IT_PROBE_ERROR " + error.message);
            }
        }

        private function hasPauseOverlay(container:DisplayObjectContainer):Boolean {
            for (var index:int = 0; index < container.numChildren; index++) {
                if (getQualifiedClassName(container.getChildAt(index)) == "Art_UI_Pause") return true;
            }
            return false;
        }

        private function startDuel(ui:Object):void {
            var options:Object = domain.getDefinition("DataCenter");
            var signals:Object = domain.getDefinition("zlong.bombIt.ui.UIEvent");
            var renderOptions:Object = domain.getDefinition("zlong.renderengine.RenderSetting");
            var renderMode:Object = domain.getDefinition("zlong.renderengine.RenderMode");
            renderOptions.RENDER_MODE = renderMode.NATIVE;
            renderOptions.ASSET_SCALE = 1;
            options.gameMode = modeId;
            options.currentStage = mapId;
            options.totalPlayer = 2;
            options.totalEnemie = seatCount - 2;
            var firstOutfit:Array = seatOutfit(0);
            var secondOutfit:Array = seatOutfit(1);
            options.P1Robot = firstOutfit[3];
            options.P2Robot = secondOutfit[3];
            options.P3Robot = seatOutfit(2)[3];
            options.P4Robot = seatOutfit(3)[3];
            options.P1ClothId = firstOutfit[0];
            options.P1HatId = firstOutfit[1];
            options.P1ExpId = firstOutfit[2];
            options.P2ClothId = secondOutfit[0];
            options.P2HatId = secondOutfit[1];
            options.P2ExpId = secondOutfit[2];
            var menu:DisplayObjectContainer = ui.uiContainer;
            menu.removeChildren();
            menu.dispatchEvent(new Event(signals.GAME_START));
        }

        private function prepareHumanSeats(controller:Object):void {
            if (controller.players.length != seatCount || controller.robots.length != seatCount ||
                controller.personalPlayers.length != 2 || controller.aiPlayers.length != seatCount - 2) {
                throw new Error("Original player slots are not ready");
            }
            if (seatCount > 2) {
                // The stock constructor supports two humans and two opponent slots. Reuse its
                // normal person/robot classes for the extra slots once the stock map is ready.
                var personClass:Class = domain.getDefinition("zlong.bombIt.gameEngine.PersonPlayer") as Class;
                for (var seat:int = 2; seat < seatCount; seat++) {
                    var opponent:Object = controller.players[seat];
                    var spawn:Array = opponent.robotPos;
                    opponent.deleteRobot();
                    var outfit:Array = seatOutfit(seat);
                    var person:Object = new personClass(controller, outfit[0], outfit[1], outfit[2]);
                    person.name = "player" + seat;
                    person.initLife = controller.playerLife;
                    person.addRobot(outfit[3], spawn, seat);
                    controller.players[seat] = person;
                    controller.personalPlayers.push(person);
                    if (modeId == "pacMan") controller.view.gameInterface.setScore(seat, 0);
                }
                controller.aiPlayers.length = 0;
                controller.playerCount = seatCount;
            }
            if (controller.personalPlayers.length != seatCount || controller.robots.length != seatCount ||
                controller.aiPlayers.length != 0) {
                throw new Error("Original human-player roster was not installed");
            }
            for (var index:int = 0; index < seatCount; index++) {
                var robot:Object = controller.players[index].robot;
                var selected:Array = seatOutfit(index);
                // The original menu uses zero-based IDs and the actor model uses one-based IDs.
                if (robot.model.clothID != selected[0] + 1 || robot.model.hatID != selected[1] + 1 ||
                    robot.model.expID != selected[2] + 1 || robot.model.robotID != selected[3] + 1) {
                    throw new Error("Original player appearance was not installed at seat " + index);
                }
                bindSeat(robot.interactiveController, SEAT_KEYS[index]);
            }
            seatsReady = true;
            trace("BOMB_IT_PROBE_HUMAN_PLAYERS " + seatCount);
        }

        private function seatOutfit(seat:int):Array {
            return seat < outfits.length ? outfits[seat] : [0, 0, 0, seat];
        }

        private function bindSeat(controller:Object, keys:Array):void {
            controller.leftKey = keys[0];
            controller.rightKey = keys[1];
            controller.upKey = keys[2];
            controller.downKey = keys[3];
            controller.bombKey = keys[4];
        }

        private function playerStates(players:Array):Array {
            var states:Array = [];
            if (!players) return states;
            for each (var player:Object in players) {
                states.push(fields(player, PLAYER_FIELDS).concat([
                    player.points ? player.points.killRobotNum : null, player.levelPoint, objective(player.points)
                ]));
            }
            return states;
        }

        private function objective(points:Object):int {
            if (!points) return 0;
            if (modeId == "collect") return points.getStartNum;
            if (modeId == "pacMan") return points.getCoinNum;
            if (modeId == "frozen") return points.frozenRobotNum + points.frozenMonsterNum;
            return points.killRobotNum;
        }

        private function fields(target:Object, names:Array):Array {
            var values:Array = [];
            for each (var name:String in names) {
                var value:* = target && name in target ? target[name] : null;
                values.push(value is Number || value is Boolean || value is String ? value : null);
            }
            return values;
        }

        private function actors(collection:Object, names:Array, includeBombs:Boolean = false):Array {
            var values:Array = [];
            if (!collection) return values;
            for (var index:int = 0; index < collection.length; index++) {
                var actor:Object = collection[index];
                var sample:Array = fields(actor, names);
                if (includeBombs) {
                    var model:Object = actor && "model" in actor ? actor.model : null;
                    sample.push([model ? model.bombNum : null, model ? actors(model.bombArr, BOMB_FIELDS) : []]);
                }
                values.push(sample);
            }
            return values;
        }

        private function grid(map:Object):Array {
            var values:Array = [];
            if (!map || !map.mapArr) return values;
            for each (var row:Object in map.mapArr) {
                var cells:Array = [];
                for each (var cell:Object in row) {
                    if (!cell) {
                        cells.push(null);
                        continue;
                    }
                    cells.push([
                        presence(cell, "fixedBox"),
                        presence(cell, "unfixedBox"),
                        presence(cell, "fire"),
                        presence(cell, "prop"),
                        actors(cell.bombArr, BOMB_FIELDS),
                        presence(cell, "box"),
                        cell.box ? cell.box.canDestroy : null
                    ]);
                }
                values.push(cells);
            }
            return values;
        }

        private function presence(target:Object, name:String):* {
            var value:* = name in target ? target[name] : null;
            if (value == null || value is Number || value is Boolean || value is String) return value;
            return getQualifiedClassName(value);
        }
    }
}
