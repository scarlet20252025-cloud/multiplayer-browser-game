export const ARENA_RUNTIME = 'tank-arena';
export const ARENA_SOCKET = '/tank-match';
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const WIDTH = 960;
export const HEIGHT = 600;
export const COLUMNS = 9;
export const ROWS = 5;
export const TICK_RATE = 60;
export const SCORE_TO_WIN = 3;
export const ARMOR = 1;
export const HULL_RADIUS = 17;
export const MOVE_SPEED = 130;
export const TURN_SPEED = 2.6;
export const SHELL_SPEED = 290;
export const SHELL_BOUNCES = 24;
export const SHELL_LIFETIME = 12;
export const SEEKER_ARM_SECONDS = .65;
export const PULSE_CHARGE_SECONDS = .65;
export const ROUND_GAP = .65;
export const COUNTDOWN = 1.5;
export const DEFAULT_MODE = 'beacon';
export const BEACON = Object.freeze({x: WIDTH / 2, y: HEIGHT / 2, radius: 62, captureSeconds: 4.5});
export const COLORS = Object.freeze(['#72ebd0', '#ffb764', '#b7a5ff', '#f78daa', '#7dc7ff', '#dfed78']);
export const MODES = Object.freeze({
  beacon: Object.freeze({label:'信标争夺', description:'独占信标或赢得生存小局得一分，先得 3 分获胜。最后一辆对手自毁时小局不计分。', scoreToWin:SCORE_TO_WIN}),
  deathmatch: Object.freeze({label:'十杀竞速', description:'被击毁后复活，率先击毁其他坦克 10 次获胜。', scoreToWin:10, respawns:true}),
  elimination: Object.freeze({label:'最后一辆', description:'每小局一次机会，赢得小局得一分，先得 3 分获胜。最后一辆对手自毁时小局不计分。', scoreToWin:SCORE_TO_WIN}),
  relay: Object.freeze({label:'巡回占领', description:'每 10 秒移动信标，独占累计 1 秒得 1 分。被击毁后复活，先得 20 分获胜。', scoreToWin:20, respawns:true}),
});
export const SUPPLIES = Object.freeze({
  shield: Object.freeze({label:'护甲', color:'#93c9ff', description:'吸收下一次命中。'}),
  scatter: Object.freeze({label:'扇形弹', color:'#f6b86f', description:'下次开火发射五发散射弹。'}),
  pulse: Object.freeze({label:'贯穿炮', color:'#d1a9ff', description:'按空格蓄力后释放持续 2 秒的穿墙光束。蓄力和照射期间车体无法移动或转向。'}),
  mine: Object.freeze({label:'感应雷', color:'#cce273', description:'激活后隐形，踩入便会触发。布雷时已在范围内的坦克需要走开再踩入。'}),
  burst: Object.freeze({label:'加特林', color:'#8de4ed', description:'长按空格热机后连续开火。松手停火并保留余弹。'}),
  seeker: Object.freeze({label:'追踪导弹', color:'#ffac83', description:`自由飞行 ${SEEKER_ARM_SECONDS} 秒后锁定对手。目标被挡住时会切换到看得见的对手，有机会时可重新追踪。尾焰取锁定目标的颜色。`}),
  cluster: Object.freeze({label:'破片弹', color:'#fae67a', description:'主弹可反弹，引爆前锁住普通炮。松开再按空格引爆，三角破片飞散并在碰墙时停止。'}),
  guide: Object.freeze({label:'遥控导弹', color:'#7ed5ff', description:'A / D 向两侧施加牵引力。碰墙反弹时略微提速，反弹后要重新修正方向。'}),
  beam: Object.freeze({label:'激光束', color:'#f88fc8', description:'车头虚线预示最多四次反弹。光束前缘沿途命中，尾部随后经过并衰减。'}),
  double: Object.freeze({label:'双管炮', color:'#ffbf7c', description:'左右两根炮管交替射击，打空后恢复标准炮。'}),
  boost: Object.freeze({label:'加速器', color:'#93f1ac', description:'暂时提高坦克前进和后退速度。'}),
  aimer: Object.freeze({label:'弹道瞄准器', color:'#a8e6ea', description:'暂时显示标准炮弹的反弹虚线，仅自己可见。'}),
});

const BORDER = 16;
const WALL = 14;
const DIMENSIONS = [[9,5],[11,5],[11,7],[13,7],[13,9]];
export const SPAWNS = [[0,2],[COLUMNS-1,2]];
export const wrapAngle = angle => Math.atan2(Math.sin(angle),Math.cos(angle));

export function randomFrom(seed){
  let state=seed>>>0;
  return ()=>{
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    return state/0x100000000;
  };
}

function dimensions(playerCount){
  const [columns,rows]=DIMENSIONS[(playerCount??MIN_PLAYERS)-MIN_PLAYERS]??DIMENSIONS[0];
  return {columns,rows,
    width:WIDTH+(columns-COLUMNS)*104,
    height:HEIGHT+(rows-ROWS)*114};
}

const lineX=(col,{columns,width})=>BORDER+Math.round((width-BORDER*2)*col/columns);
const lineY=(row,{rows,height})=>BORDER+Math.round((height-BORDER*2)*row/rows);
const center=(col,row,size)=>({x:(lineX(col,size)+lineX(col+1,size))/2,y:(lineY(row,size)+lineY(row+1,size))/2});
export const cellCenter=(col,row,playerCount=MIN_PLAYERS)=>center(col,row,dimensions(playerCount));

function spawnCells(playerCount,columns,rows){
  const last=columns-1, middle=(rows-1)/2;
  if(playerCount===2)return SPAWNS;
  if(playerCount===3)return [[0,1],[last,rows-2],[(columns-1)/2,rows-1]];
  const corners=[[0,1],[last,rows-2],[last,1],[0,rows-2]];
  return [...corners,[0,middle],[last,middle]].slice(0,playerCount);
}

function halfEdges(half,rows){
  const edges=[];
  for(let row=0;row<rows;row++)for(let col=0;col<half;col++){
    const cell=row*half+col;
    if(col+1<half)edges.push({from:cell,to:cell+1,col:col+1,row,vertical:true});
    if(row+1<rows)edges.push({from:cell,to:cell+half,col,row:row+1,vertical:false});
  }
  return edges;
}

function divider(col,row,vertical,size){
  const x=lineX(col,size),y=lineY(row,size);
  return vertical
    ? {x:x-WALL/2,y:y-WALL/2,w:WALL,h:lineY(row+1,size)-y+WALL}
    : {x:x-WALL/2,y:y-WALL/2,w:lineX(col+1,size)-x+WALL,h:WALL};
}

function mergeRuns(walls){
  const groups=new Map();
  for(const wall of walls){
    const key=wall.w===WALL?`x${wall.x}`:`y${wall.y}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(wall);
  }
  return [...groups.values()].flatMap(group=>{
    const vertical=group[0].w===WALL;
    const axis=vertical?'y':'x', span=vertical?'h':'w';
    group.sort((a,b)=>a[axis]-b[axis]);
    const merged=[];
    for(const wall of group){
      const previous=merged.at(-1);
      if(previous&&previous[axis]+previous[span]>=wall[axis])
        previous[span]=Math.max(previous[span],wall[axis]+wall[span]-previous[axis]);
      else merged.push({...wall});
    }
    return merged;
  });
}

export function arenaFor(seed,playerCount=MIN_PLAYERS){
  const size=dimensions(playerCount);
  const {columns,rows,width,height}=size;
  const half=(columns-1)/2, midRow=(rows-1)/2;
  const random=randomFrom(seed),edges=halfEdges(half,rows);
  for(let index=edges.length-1;index>0;index--){
    const other=Math.floor(random()*(index+1));
    [edges[index],edges[other]]=[edges[other],edges[index]];
  }
  const parent=Array.from({length:half*rows},(_,index)=>index);
  const root=cell=>{
    while(parent[cell]!==cell)cell=parent[cell];
    return cell;
  };
  const closed=[];
  for(const edge of edges){
    const from=root(edge.from),to=root(edge.to);
    if(from===to)closed.push(edge);
    else parent[to]=from;
  }
  const left=closed.slice(Math.max(4,Math.round(closed.length*.32)))
    .map(edge=>divider(edge.col,edge.row,edge.vertical,size));
  const flankRows=Array.from({length:rows},(_,row)=>row).filter(row=>row!==midRow);
  const flank=flankRows.splice(Math.floor(random()*flankRows.length),1)[0];
  const extra=rows>=7?flankRows[Math.floor(random()*flankRows.length)]:-1;
  for(let row=0;row<rows;row++)if(row!==midRow&&row!==flank&&row!==extra)left.push(divider(half,row,true,size));
  const opposite=left.map(({x,y,w,h})=>({x:width-x-w,y:height-y-h,w,h}));
  const perimeter=[
    {x:0,y:0,w:BORDER,h:height},{x:width-BORDER,y:0,w:BORDER,h:height},
    {x:BORDER,y:0,w:width-2*BORDER,h:BORDER},{x:BORDER,y:height-BORDER,w:width-2*BORDER,h:BORDER},
  ];
  const spawns=spawnCells(playerCount,columns,rows).map(([col,row])=>center(col,row,size));
  return {...size,spawns,beacon:{...BEACON,x:width/2,y:height/2},walls:[...perimeter,...mergeRuns([...left,...opposite])]};
}
