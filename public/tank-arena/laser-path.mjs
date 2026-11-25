export const LASER_RADIUS=2;
export const LASER_RANGE=1560;
export const LASER_REFLECTIONS=4;
export const LASER_SPEED=1860;
export const LASER_WAVE_LENGTH=220;
const EPS=.000001;
const NUDGE=.00001;

function slab(origin,direction,min,max){
  if(Math.abs(direction)<1e-12){
    return origin<min||origin>max?null:{enter:-Infinity,exit:Infinity};
  }
  const near=(min-origin)/direction,far=(max-origin)/direction;
  return {enter:Math.min(near,far),exit:Math.max(near,far)};
}

function closestWall(start,dx,dy,walls,range,radius){
  let closest=null;
  for(const {x,y,w,h} of walls){
    const column=slab(start.x,dx,x-radius,x+w+radius);
    const row=slab(start.y,dy,y-radius,y+h+radius);
    if(!column||!row)continue;
    const distance=Math.max(column.enter,row.enter);
    const exit=Math.min(column.exit,row.exit);
    if(distance<0||distance>range||exit-distance<=EPS)continue;
    const flipX=column.enter>=distance-EPS,flipY=row.enter>=distance-EPS;
    if(!closest||distance<closest.distance-EPS)closest={distance,flipX,flipY};
    else if(Math.abs(distance-closest.distance)<=EPS){
      closest.distance=Math.min(closest.distance,distance);
      closest.flipX||=flipX;
      closest.flipY||=flipY;
    }
  }
  return closest;
}

function tracePath(origin,heading,walls,radius,range,reflections){
  const points=[{x:origin.x,y:origin.y}];
  let dx=Math.cos(heading),dy=Math.sin(heading),remaining=range;
  for(let leg=0;leg<=reflections;leg++){
    const from=points.at(-1);
    const offset=NUDGE;
    if(remaining<=offset)break;
    const start={x:from.x+dx*offset,y:from.y+dy*offset};
    // Reject a ray directed into an adjoining wall at a joint.
    if(walls.some(({x,y,w,h})=>start.x>x-radius+EPS&&start.x<x+w+radius-EPS&&
      start.y>y-radius+EPS&&start.y<y+h+radius-EPS))break;
    const hit=closestWall(start,dx,dy,walls,remaining-offset,radius);
    const travelled=hit?offset+hit.distance:remaining;
    points.push({x:from.x+dx*travelled,y:from.y+dy*travelled});
    if(!hit)break;
    remaining-=travelled;
    if(hit.flipX)dx=-dx;
    if(hit.flipY)dy=-dy;
  }
  return points;
}

export function laserPath(origin,heading,walls){
  return tracePath(origin,heading,walls,LASER_RADIUS,LASER_RANGE,LASER_REFLECTIONS);
}

export function shellAimPath(origin,heading,walls){
  return tracePath(origin,heading,walls,4,610,2);
}
