const platformDirections=[null,['KeyA','◀','向左移动'],['KeyD','▶','向右移动']];
const jump=['KeyW','跳跃','跳跃'];
const layouts={
  tank:{label:'坦克触屏控制',directions:[['KeyW','▲','前进'],['KeyA','↶','左转'],['KeyD','↷','右转'],['KeyS','▼','后退']],
    actions:[['Space','开火','朝车头方向开火']]},
  fighter:{label:'格斗触屏控制',directions:[['KeyW','▲','上'],['KeyA','◀','左'],['KeyD','▶','右'],['KeyS','▼','下']],
    actions:[['KeyU','远攻','远攻'],['KeyI','必杀','必杀'],['KeyO','援助','援助'],['KeyJ','攻击','攻击或确认'],['KeyK','跳跃','跳跃'],['KeyL','冲刺','冲刺'],['Escape','返回','取消或返回']]},
  temple:{label:'冰火人触屏控制',directions:platformDirections,actions:[jump]},
  shanyi:{label:'闪翼双星触屏控制',directions:platformDirections,actions:[jump,['KeyS','下','向下移动或攀爬']]},
  brawl:{label:'云台乱斗触屏控制',directions:platformDirections,actions:[jump,['KeyJ','快攻','快速攻击'],['KeyK','重击','重击']]},
};

const touchPointer='(pointer: coarse) and (hover: none)';
const finePointer='(any-pointer: fine)';
const compactViewport='(max-width: 1024px), (max-height: 600px)';

export function canMountTouchControls(){
  return navigator.maxTouchPoints>0&&matchMedia(touchPointer).matches&&
    !matchMedia(finePointer).matches&&matchMedia(compactViewport).matches;
}

export function mountTouchControls(anchor,variant,onChange){
  if(!canMountTouchControls())return null;
  const layout=layouts[variant];
  const panel=document.createElement('section');
  panel.className=`match-touch match-touch--${variant}`;
  panel.setAttribute('aria-label',layout.label);
  panel.hidden=true;

  const directions=document.createElement('div');
  directions.className='match-touch-directions';
  directions.setAttribute('role','group');
  directions.setAttribute('aria-label','方向');
  const actions=document.createElement('div');
  actions.className='match-touch-actions';
  actions.setAttribute('role','group');
  actions.setAttribute('aria-label','动作');
  const buttons=new Map();
  function addButton(group,[code,title,label],area){
    const button=document.createElement('button');
    button.type='button';
    button.dataset.touchCode=code;
    button.textContent=title;
    button.setAttribute('aria-label',label);
    if(area)button.style.gridArea=area;
    group.append(button);
    buttons.set(code,button);
  }
  layout.directions.forEach((data,index)=>{if(data)addButton(directions,data,['up','left','right','down'][index]);});
  layout.actions.forEach(data=>addButton(actions,data));
  panel.append(directions,actions);
  anchor.after(panel);

  const pointers=new Map();
  const focused=new Map();
  const pulses=new Map();
  let held=new Set();
  function update(){
    const next=new Set([...focused.values(),...pulses.keys()]);
    for(const pointer of pointers.values())for(const code of pointer.codes)next.add(code);
    if(held.size===next.size&&[...next].every(code=>held.has(code)))return false;
    held=next;
    for(const [code,button] of buttons)button.toggleAttribute('data-held',held.has(code));
    onChange(next);
    return true;
  }
  function clear(){
    for(const id of pointers.keys())if(panel.hasPointerCapture(id))panel.releasePointerCapture(id);
    for(const timer of pulses.values())clearTimeout(timer);
    pointers.clear();focused.clear();pulses.clear();
    return update();
  }
  function directionAt(event){
    const rect=directions.getBoundingClientRect();
    const x=(event.clientX-rect.left-rect.width/2)/(rect.width/2);
    const y=(event.clientY-rect.top-rect.height/2)/(rect.height/2);
    if(Math.abs(x)>1.3||Math.abs(y)>1.3)return [];
    const codes=[];
    if(x<-.32)codes.push('KeyA');
    if(x>.32)codes.push('KeyD');
    if(layout.directions[0]&&y<-.32)codes.push('KeyW');
    if(layout.directions[3]&&y>.32)codes.push('KeyS');
    return codes;
  }
  panel.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const button=event.target.closest('button[data-touch-code]');
    const direction=directions.contains(event.target);
    if(!direction&&!button)return;
    event.preventDefault();
    pointers.set(event.pointerId,{direction,codes:direction?directionAt(event):[button.dataset.touchCode]});
    try{panel.setPointerCapture(event.pointerId);}catch{}
    update();
  });
  panel.addEventListener('pointermove',event=>{
    const pointer=pointers.get(event.pointerId);
    if(!pointer?.direction)return;
    pointer.codes=directionAt(event);
    update();
  });
  function releasePointer(event){if(pointers.delete(event.pointerId))update();}
  window.addEventListener('pointerup',releasePointer);
  window.addEventListener('pointercancel',releasePointer);
  panel.addEventListener('lostpointercapture',releasePointer);
  panel.addEventListener('contextmenu',event=>{event.preventDefault();clear();});
  for(const [code,button] of buttons){
    button.addEventListener('keydown',event=>{
      if(!['Space','Enter'].includes(event.code))return;
      event.preventDefault();event.stopPropagation();
      focused.set(event.code,code);
      update();
    });
    button.addEventListener('keyup',event=>{
      if(!['Space','Enter'].includes(event.code))return;
      event.preventDefault();event.stopPropagation();
      if(focused.delete(event.code))update();
    });
    button.addEventListener('blur',()=>{
      for(const [key,pressed] of focused)if(pressed===code)focused.delete(key);
      update();
    });
    button.addEventListener('click',event=>{
      if(event.detail!==0)return;
      clearTimeout(pulses.get(code));
      pulses.set(code,setTimeout(()=>{pulses.delete(code);update();},110));
      update();
    });
  }
  window.addEventListener('blur',clear);
  window.addEventListener('pagehide',clear);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();});
  if(screen.orientation?.addEventListener)screen.orientation.addEventListener('change',clear);
  else window.addEventListener('orientationchange',clear);

  let stylesLoaded=false;
  function syncVisibility(){
    panel.hidden=!stylesLoaded||!canMountTouchControls();
    if(panel.hidden)clear();
  }
  for(const query of [touchPointer,finePointer,compactViewport])
    matchMedia(query).addEventListener('change',syncVisibility);

  function loadStyles(retry=false){
    const style=document.createElement('link');
    style.rel='stylesheet';
    const href=new URL('./touch.css',import.meta.url);
    if(retry)href.searchParams.set('retry','1');
    style.href=href;
    const failed=()=>{
      clearTimeout(timer);
      style.onload=style.onerror=null;
      style.remove();
      if(!retry)loadStyles(true);
    };
    const timer=setTimeout(failed,4500);
    style.onload=()=>{clearTimeout(timer);stylesLoaded=true;syncVisibility();};
    style.onerror=failed;
    document.head.append(style);
  }
  loadStyles();
  return {clear};
}
