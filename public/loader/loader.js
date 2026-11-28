(() => {
 const stages=['download','verify','initialize'];
 const labels={download:'正在下载游戏资源',verify:'正在校验游戏文件',initialize:'正在初始化游戏'};
 const statuses={idle:'准备开始',running:'加载中',paused:'已暂停',error:'加载失败',done:'加载完成'};
 const instances=new Set();
 const visibility=()=>instances.forEach(l=>l.root.toggleAttribute('data-suspended',document.hidden));
 document.addEventListener('visibilitychange',visibility);
 class CarnivalLoader {
  constructor(root, options={}){
   if(!(root instanceof Element))throw new TypeError('需要有效的挂载节点');
   this.root=root;root.classList.add('cl-card');root.toggleAttribute('data-compact',!!options.compact);this.setMotion(options.motion!==false);
   root.innerHTML=`<div class="cl-head"><h2 class="cl-title"></h2><div class="cl-number" aria-hidden="true"></div></div><div class="cl-route"><div class="cl-rail" role="progressbar" aria-label="游戏加载进度" aria-valuemin="0" aria-valuemax="100"><div class="cl-track"><div class="cl-fill"></div></div></div><div class="cl-runway" aria-hidden="true"><div class="cl-runner"><div class="cl-art"></div></div></div></div><div class="cl-meta"><p class="cl-detail"></p><span class="cl-bytes"></span></div><div class="cl-stage"><span class="cl-status" role="status" aria-live="polite"></span><ol class="cl-stage-list" aria-label="加载阶段"><li>下载资源</li><li>校验文件</li><li>初始化游戏</li></ol></div>`;
   this.nodes=Object.fromEntries(['title','number','rail','detail','bytes','status'].map(k=>[k,root.querySelector('.cl-'+k)]));
   this.model={progress:0,stage:'download',state:'idle',detail:'准备好一起冒险了吗？',bytes:''};instances.add(this);visibility();this.update(options.initial||{});
  }
  update(patch={}){
   const next={...this.model,...patch};if(!stages.includes(next.stage))throw new RangeError('未知加载阶段');if(!Object.hasOwn(statuses,next.state))throw new RangeError('未知加载状态');
   if(next.progress!==null&&(typeof next.progress!=='number'||!Number.isFinite(next.progress)))throw new TypeError('progress 必须是有限数值或 null');
   if(next.progress!==null)next.progress=Math.min(100,Math.max(0,next.progress));if(next.state==='done'){next.progress=100;next.stage='initialize';}
   this.model=next;const known=next.progress!==null,r=this.root,n=this.nodes;
   r.dataset.state=next.state;r.dataset.known=String(known);r.style.setProperty('--cl-progress',`${known?next.progress:0}%`);
   n.title.textContent=next.state==='done'?'准备完毕，出发吧！':next.state==='error'?'加载遇到问题':next.state==='paused'?'休息一下':labels[next.stage];
   n.number.textContent=known?String(Math.floor(next.progress)):'···';if(known){const s=document.createElement('small');s.textContent='%';n.number.append(s);n.rail.setAttribute('aria-valuenow',String(Math.round(next.progress)));}else n.rail.removeAttribute('aria-valuenow');
   n.rail.setAttribute('aria-valuetext',known?`${Math.round(next.progress)}%，${labels[next.stage]}`:`${labels[next.stage]}，进度未知`);
   n.detail.textContent=next.detail||'';n.bytes.textContent=next.bytes||'';if(n.status.textContent!==statuses[next.state])n.status.textContent=statuses[next.state];
   const active=stages.indexOf(next.stage);r.querySelectorAll('.cl-stage-list li').forEach((li,i)=>{li.toggleAttribute('data-done',i<active||next.state==='done');li.toggleAttribute('data-current',i===active&&next.state!=='done');if(i===active&&next.state!=='done')li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});return this;
  }
  setMotion(enabled){this.root.dataset.motion=enabled?'on':'off';return this;}
  destroy(){instances.delete(this);this.root.replaceChildren();this.root.classList.remove('cl-card');for(const k of ['compact','state','known','suspended','motion'])delete this.root.dataset[k];this.root.style.removeProperty('--cl-progress');}
 }
 window.CarnivalLoader=CarnivalLoader;
})();
