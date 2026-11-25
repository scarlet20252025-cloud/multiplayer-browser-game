import {COLUMNS,ROWS,arenaFor,cellCenter} from '../public/tank-arena/rules.mjs';

export function cellOf(point){
  const nearest=(count,axis,position)=>{
    const distances=Array.from({length:count},(_,index)=>Math.abs(position-axis(index)));
    return distances.indexOf(Math.min(...distances));
  };
  return [nearest(COLUMNS,col=>cellCenter(col,0).x,point.x),nearest(ROWS,row=>cellCenter(0,row).y,point.y)];
}

export function pathsFrom(seed,start){
  const {walls}=arenaFor(seed);
  const paths=new Map([[start.join(','),[]]]);
  const queue=[start];
  for(const [col,row] of queue){
    const from=cellCenter(col,row);
    for(const [nextCol,nextRow] of [[col+1,row],[col-1,row],[col,row+1],[col,row-1]]){
      if(nextCol<0||nextCol>=COLUMNS||nextRow<0||nextRow>=ROWS)continue;
      const key=nextCol+','+nextRow;
      if(paths.has(key))continue;
      const to=cellCenter(nextCol,nextRow);
      const x=(from.x+to.x)/2,y=(from.y+to.y)/2;
      if(walls.some(wall=>x>=wall.x&&x<=wall.x+wall.w&&y>=wall.y&&y<=wall.y+wall.h))continue;
      queue.push([nextCol,nextRow]);
      paths.set(key,[...paths.get(col+','+row),[nextCol,nextRow]]);
    }
  }
  return paths;
}
