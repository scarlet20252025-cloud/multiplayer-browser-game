export const PALETTES = [
  {base:'#64dec4', shade:'#168b86', shine:'#b7f7dc'},
  {base:'#ffb565', shade:'#c35c4b', shine:'#ffe1a3'},
  {base:'#bfacfa', shade:'#8257bf', shine:'#e8dcfc'},
  {base:'#fd93a9', shade:'#bd567d', shine:'#ffd1d9'},
  {base:'#7ecdf4', shade:'#497edd', shine:'#c9ecff'},
  {base:'#e7db7a', shade:'#a79144', shine:'#fff4b7'},
];

function shape(context, points) {
  context.beginPath();
  for (const [index, point] of points.entries()) {
    if (index) context.lineTo(...point);
    else context.moveTo(...point);
  }
  context.closePath();
}

function rounded(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fillRound(context, x, y, width, height, radius, color) {
  rounded(context, x, y, width, height, radius);
  context.fillStyle = color;
  context.fill();
}

function ellipse(context, x, y, rx, ry, color) {
  context.beginPath();
  context.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

function sparkle(context, x, y, size, color) {
  shape(context, [[x,y-size],[x+size*.23,y-size*.25],[x+size,y],[x+size*.23,y+size*.22],
    [x,y+size],[x-size*.23,y+size*.22],[x-size,y],[x-size*.23,y-size*.25]]);
  context.fillStyle=color;
  context.fill();
}

function cloud(context, x, y, scale, color) {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.beginPath();
  context.moveTo(-93, 19);
  context.bezierCurveTo(-136, 11, -117, -25, -79, -24);
  context.bezierCurveTo(-79, -57, -42, -66, -22, -45);
  context.bezierCurveTo(0, -84, 55, -67, 58, -28);
  context.bezierCurveTo(93, -47, 125, -14, 98, 8);
  context.bezierCurveTo(140, 17, 77, 50, -93, 19);
  context.fillStyle = color;
  context.fill();
  context.restore();
}

function pennants(context, x, y, direction) {
  context.save();
  context.translate(x,y);
  context.scale(direction,1);
  context.beginPath();
  context.moveTo(-15,0);
  context.quadraticCurveTo(145,65,291,26);
  context.strokeStyle='#6b63a54e';
  context.lineWidth=2;
  context.stroke();
  const fills=['#f5be82','#e898b1','#c6a2e1','#f3d79d'];
  for(let i=0;i<7;i++){
    const a=15+i*40;
    const b=11+Math.sin((i+1)/8*Math.PI*.84)*27;
    shape(context,[[a,b],[a+23,b+3],[a+7,b+24]]);
    context.fillStyle=fills[i%fills.length];
    context.fill();
  }
  context.restore();
}

function makeSky(width,height) {
  const layer=document.createElement('canvas');
  layer.width=width;layer.height=height;
  const context=layer.getContext('2d');
  const sky=context.createLinearGradient(0,0,0,height);
  sky.addColorStop(0,'#6ba5df');
  sky.addColorStop(.45,'#a8ccef');
  sky.addColorStop(.77,'#f1bed2');
  sky.addColorStop(1,'#74689e');
  context.fillStyle=sky;
  context.fillRect(0,0,width,height);

  const halo=context.createRadialGradient(width*.51,151,36,width*.51,151,265);
  halo.addColorStop(0,'#fff7b7a1');
  halo.addColorStop(1,'#fff3c800');
  context.fillStyle=halo;context.fillRect(0,0,width,420);
  ellipse(context,width*.51,151,67,67,'#fff2bd85');
  ellipse(context,width*.51,151,53,53,'#fff6d1b3');
  cloud(context,70,152,.57,'#f5e9ffb7');
  cloud(context,807,124,.58,'#fbf0fbd6');
  cloud(context,873,260,.97,'#e1c3e4b8');
  cloud(context,65,319,1,'#d9c6edad');
  cloud(context,309,330,.64,'#eee3f98e');
  cloud(context,642,341,.73,'#f6e0f2a8');
  pennants(context,0,11,1);
  pennants(context,width,15,-1);

  // Rooftops far below provide depth while the four collision surfaces stay prominent.
  for(let i=0;i<10;i++){
    const x=i*111-12;
    const y=459+Math.sin(i*3.1)*16;
    shape(context,[[x,y],[x+48,y-32],[x+96,y],[x+80,y],[x+80,y+71],[x+18,y+71],[x+18,y]]);
    context.fillStyle=i%2?'#78698e5e':'#66729062';
    context.fill();
    fillRound(context,x+35,y+12,11,18,4,'#f9d99ca4');
    fillRound(context,x+52,y+12,11,18,4,'#f9d99ca4');
  }
  cloud(context,38,510,.86,'#8074a9');
  cloud(context,208,554,1.26,'#aa8fbd');
  cloud(context,390,552,.83,'#8f7aaa');
  cloud(context,588,554,1.07,'#9a82b2');
  cloud(context,770,556,.93,'#786da0');
  cloud(context,934,527,1.09,'#ac90be');
  for(let i=0;i<23;i++){
    const x=(i*149+37)%width;
    const y=(i*43+85)%370;
    sparkle(context,x,y,2+i%3,'#fff6dec3');
  }
  return layer;
}

function ledge(context, {x,y,width,height}) {
  ellipse(context,x+width/2,y+height*.96,width*.51,10,'#37345a3f');
  shape(context,[[x+17,y+height*.68],[x+width-17,y+height*.68],[x+width-33,y+height+15],[x+33,y+height+15]]);
  context.fillStyle='#524364';context.fill();
  shape(context,[[x+30,y+height*.76],[x+width-31,y+height*.76],[x+width-42,y+height+11],[x+41,y+height+11]]);
  context.fillStyle='#baa0bf';context.fill();
  for(let slat=x+47;slat<x+width-26;slat+=27)fillRound(context,slat,y+height-1,13,9,3,'#ffdca6');

  rounded(context,x,y,width,height,7);
  const tile=context.createLinearGradient(0,y,0,y+height);
  tile.addColorStop(0,'#8ce6d4');
  tile.addColorStop(.33,'#48b3b6');
  tile.addColorStop(1,'#3d708e');
  context.fillStyle=tile;context.fill();
  context.strokeStyle='#364b65';context.lineWidth=3;context.stroke();
  fillRound(context,x+3,y+1,width-6,5,2,'#c9fae4');
  for(let post=x+19;post<x+width-7;post+=24){
    context.beginPath();
    context.moveTo(post,y+7);context.lineTo(post+2,y+height-2);
    context.strokeStyle='#265f796b';context.lineWidth=1.6;context.stroke();
    context.beginPath();context.moveTo(post+2,y+7);context.lineTo(post+4,y+height-3);
    context.strokeStyle='#b2eee581';context.lineWidth=1;context.stroke();
  }
  for(const medal of [x+11,x+width-11]){
    ellipse(context,medal,y+9,5,5,'#9d5c6f');
    sparkle(context,medal,y+8,4.5,'#ffe299');
  }
}

function attackWave(context, kind, shade) {
  const reach=kind==='heavy'?51:35;
  context.translate(12,-18);
  context.beginPath();
  context.ellipse(0,0,reach,kind==='heavy'?32:22,0,-1.2,1.16);
  context.strokeStyle=shade;
  context.lineWidth=kind==='heavy'?8:5;
  context.stroke();
  context.strokeStyle='#fff9d6';
  context.lineWidth=2.2;
  context.stroke();
  sparkle(context,reach-1,-6,5,'#fff8ca');
}

function drawPlayer(context, player, seat, now) {
  if(!player.active||!player.connected) return;
  const {base,shade,shine}=PALETTES[player.seat%PALETTES.length];
  const time=Math.sin(now*.009+player.seat);
  const running=player.grounded&&Math.abs(player.vx)>30;
  const bounce=running?Math.abs(Math.sin(now*.021))*2:time*.8;
  context.save();
  context.translate(player.x,player.y);
  if(player.grounded)ellipse(context,0,2,21,5,'#38254f75');
  if(player.protected){
    context.beginPath();context.arc(0,-18,25+time*1.7,0,Math.PI*2);
    context.fillStyle='#e7fff02d';context.fill();
    context.strokeStyle='#eafff6c7';context.lineWidth=2;context.stroke();
  }
  context.translate(0,-bounce);
  context.save();
  context.scale(player.facing<0?-1:1,1);
  if(player.attack){context.save();attackWave(context,player.attack,shine);context.restore();}

  // Curved parachute fin, little boots, and a tinted glass face identify the original cloud couriers.
  context.beginPath();context.moveTo(-11,-23);
  context.quadraticCurveTo(-25,-31-time*3,-29,-19);
  context.quadraticCurveTo(-25,-9,-13,-13);
  context.fillStyle=shine;context.fill();
  context.strokeStyle='#433450';context.lineWidth=2.8;context.stroke();
  const walk=running?Math.sin(now*.021)*3:0;
  fillRound(context,-14,-8+walk,11,9,5,'#453750');
  fillRound(context,4,-8-walk,12,9,5,'#453750');
  fillRound(context,-12,-7+walk,8,4,2,base);
  fillRound(context,6,-7-walk,8,4,2,base);
  rounded(context,-17,-38,34,33,13);
  const armor=context.createLinearGradient(0,-39,0,-5);
  armor.addColorStop(0,shine);armor.addColorStop(.42,base);armor.addColorStop(1,shade);
  context.fillStyle=armor;context.fill();
  context.strokeStyle='#433450';context.lineWidth=3;context.stroke();
  fillRound(context,-10,-31,25,16,7,'#2d3750');
  fillRound(context,-6,-29,17,2,1,'#8291ab');
  ellipse(context,0,-23,2.2,3.3,'#fff5cd');
  ellipse(context,8,-23,2.2,3.3,'#fff5cd');
  fillRound(context,-5,-13,10,3,1.5,'#fff0c6');

  const glove=player.attack?(player.attack==='heavy'?25:21):14;
  ellipse(context,glove,-14,7.5,6.2,'#493958');
  ellipse(context,glove,-15.5,5.5,3.8,shine);
  context.restore();

  const sign='P'+(player.seat+1)+(player.seat===seat?' ▾':'')+' · '+Math.round(player.damage)+'%';
  context.font='800 13px system-ui,sans-serif';
  context.textAlign='center';
  const labelWidth=context.measureText(sign).width+12;
  fillRound(context,-labelWidth/2,-57,labelWidth,17,6,'#242747');
  context.fillStyle=shine;
  context.fillText(sign,0,-44.5);
  if(player.stun>0)sparkle(context,15,-65,5+time*2,'#fff4a0');
  context.restore();
}

function drawEffect(context, event, age) {
  const radius=event.type==='ringout'?24:15;
  const color=event.type==='respawn'?'#dbffec':event.type==='ringout'?'#f8c4ef':'#ffe3a1';
  context.save();
  context.translate(event.x,event.y-15);
  context.globalAlpha=1-age;
  context.lineWidth=3-age*2;
  context.strokeStyle=color;
  context.beginPath();context.arc(0,0,8+age*radius,0,Math.PI*2);context.stroke();
  for(let index=0;index<6;index++){
    const angle=index*Math.PI/3+event.id*.31;
    const distance=10+age*radius*1.7;
    sparkle(context,Math.cos(angle)*distance,Math.sin(angle)*distance,3+(1-age)*6,color);
  }
  context.restore();
}

export function createBrawlView(canvas,{width,height,platforms}) {
  const context=canvas.getContext('2d');
  const sky=makeSky(width,height);
  const effects=[];
  for(const platform of platforms)ledge(sky.getContext('2d'),platform);
  return {
    event(event,time){
      if(!['hit','ringout','respawn'].includes(event.type))return;
      effects.push({event,time});
      if(effects.length>32)effects.shift();
    },
    paint(players,seat,now){
      context.drawImage(sky,0,0);
      for(const player of players)drawPlayer(context,player,seat,now);
      while(effects.length&&now-effects[0].time>430)effects.shift();
      for(const {event,time} of effects)drawEffect(context,event,Math.max(0,(now-time)/430));
    },
  };
}
