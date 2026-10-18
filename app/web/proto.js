// prototype-v4 逻辑。独立文件是为了能 node --check 验语法。
function S(id,slot,pos,g,ge,note,m,reps,sn){return{id:id,slot:slot,pos:pos,g:g,ge:ge,note:note,m:m,reps:reps,sn:sn||[]}}

var DB={
crime:{ipa:"/kraɪm/",tier:"T1",rf:false,s:[
 S("a7f3",1,"n.","犯罪，罪行（违法行为）","(criminal law) an act punishable by law; usually considered an evil act","关键：受法律惩罚","mas",12,[
  {en:"He was convicted of a serious crime.",zh:"他被判犯有严重罪行。"},
  {en:"The police are still investigating the crime.",zh:"警方仍在调查这起犯罪。"}]),
 S("b2e9",2,"n.","罪恶（道德上的恶，不必然违法）","an evil act not necessarily punishable by law","与 s1 分界：是否受法律惩罚。","ing",3,[
  {en:"Jealousy is a sin, not a crime.",zh:"如说是罪，而不是犯罪。"},
  {en:"Greed is one of the sins of our society.",zh:"贪婪是我们社会的一种罪恶。"},
  {en:"He resigned out of guilt for his sins.",zh:"他因自己的罪恶而辞职。"}])]},
abandon:{ipa:"/əbændən/",tier:"T2",rf:false,s:[
 S("c3d1",1,"vt.","放弃，抛弃","give up, relinquish possession of","","mas",19,[
  {en:"They had to abandon the car.",zh:"他们不得不弃车。"},
  {en:"She abandoned her plans.",zh:"她放弃了计划。"},
  {en:"He abandoned the baby.",zh:"他抛弃了婴儿。"}]),
 S("d4a7",2,"vt.","遗弃（人）","leave behind; forsake","","mas",8,[
  {en:"The crew abandoned the sinking ship.",zh:"船员弃船逃生。"},
  {en:"He abandoned his children.",zh:"他抛弃了自己的孩子。"}]),
 S("e5b2",3,"vt.","放纵（沉溺）","give oneself up to","","new",0,[
  {en:"He abandoned himself to despair.",zh:"他沉溺在失望中。"},
  {en:"She abandoned herself to the music.",zh:"她沉溺在音乐中。"},
  {en:"Do not abandon yourself to worry.",zh:"不要沉溺于焦虑。"}])]},
ability:{ipa:"/əbɪləti/",tier:"T1",rf:false,s:[
 S("f6c3",1,"n.","能力，才能","the quality of being able to perform","","mas",14,[
  {en:"She has the ability to lead.",zh:"她有领导能力。"},
  {en:"He lost the ability to walk.",zh:"他失去了行走能力。"},
  {en:"That is beyond my ability.",zh:"那超出了我的能力。"}])]},
scientist:{ipa:"/saɪəntɪst/",tier:"T1",rf:true,s:[
 S("a1b2",1,"n.","科学家","a person with advanced knowledge of one or more sciences","骨架词：只给了一个意思","new",0,[
  {en:"She is a scientist at a leading laboratory.",zh:"她是一所顶级实验室的科学家。"},
  {en:"The scientist published her findings.",zh:"这位科学家发表了她的发现。"},
  {en:"He was a scientist before becoming a writer.",zh:"成为作家之前他是一名科学家。"}])]},
technology:{ipa:"/teknɒlədʒi/",tier:"T1",rf:true,s:[
 S("c3d4",1,"n.","技术","the practical application of science to commerce or industry","骨架词：用到时再补意思","new",0,[
  {en:"Technology has changed the way we work.",zh:"技术改变了我们的工作方式。"},
  {en:"The company invests heavily in technology.",zh:"这家公司在技术上投入巨大。"},
  {en:"New technology made the task easier.",zh:"新技术让这项任务更轻松。"}])]},
kill:{ipa:"/kɪl/",tier:"T1",rf:false,s:[
 S("e7f8",1,"vt.","杀死","cause the death of","","mas",22,[
  {en:"The drought killed the crops.",zh:"干旱使作物枯死。"},
  {en:"He was killed in the war.",zh:"他在战争中丧生。"},
  {en:"The pain was killing me.",zh:"疼痛快折磨死我了。"}]),
 S("f8a9",2,"vt.","消磨（时间）","consume or waste (time)","","ing",2,[
  {en:"The train killed three hours.",zh:"火车费了三小时。"},
  {en:"We killed time waiting for the bus.",zh:"我们等公交车时消磨时间。"},
  {en:"He killed an afternoon writing letters.",zh:"他写了一下午信消磨时间。"}])]},
audience:{ipa:"/ɔːdiəns/",tier:"T1",rf:false,s:[
 S("d5e6",1,"n.","听众，观众","the people who listen or watch","","ing",6,[
  {en:"The audience clapped for ten minutes.",zh:"观众鼓掌了十分钟。"},
  {en:"She is a gifted audience.",zh:"她是一位有天赋的表演者。"}])]}
};

var META={mas:["已掌握","t-mas",5,"g"],ing:["学习中","t-ing",2.4,"l"],new:["未学","t-new",0,"n"]};
var cur="all",curW="",curSlot=1;
var SOLO_MSG="单挑：只出这一个意思，连对 2 次移出错题板";

function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})}

/* ── 搜索：模糊匹配 + 键盘选择 ── */
var SUG={hits:[],sel:-1};
function sug(q){
  var box=document.getElementById("sug");
  q=(q||"").trim().toLowerCase();
  SUG.hits=[]; SUG.sel=-1;
  if(!q){box.className="sug"; box.innerHTML=""; return}
  var starts=[],contains=[];
  Object.keys(DB).forEach(function(w){
    if(w===q){starts.unshift(w); return}
    if(w.indexOf(q)===0) starts.push(w);
    else if(w.indexOf(q)>0) contains.push(w);
  });
  SUG.hits=starts.concat(contains).slice(0,8);
  if(!SUG.hits.length){
    box.innerHTML='<div class="none">没有 "'+esc(q)+'"'
      +'<button class="btn sm" id="sugNew" style="margin-top:10px">+ 新增这个词</button></div>';
    box.className="sug on"; return;
  }
  box.innerHTML=SUG.hits.map(function(w,i){
    return '<div class="i" data-w="'+w+'" data-i="'+i+'"><b>'+esc(w)+'</b>'
      +'<span class="ipa">'+esc(DB[w].ipa)+'</span><span class="n">'+DB[w].s.length+' 意思</span></div>';
  }).join("");
  box.className="sug on";
  paintSug();
}
function paintSug(){
  var box=document.getElementById("sug");
  Array.prototype.forEach.call(box.querySelectorAll(".i"),function(el){
    el.classList.toggle("on", +el.dataset.i===SUG.sel);
  });
}
function sugKey(e){
  var n=SUG.hits.length;
  if(e.key==="ArrowDown"){e.preventDefault(); SUG.sel=n?(SUG.sel+1)%n:-1; paintSug()}
  else if(e.key==="ArrowUp"){e.preventDefault(); SUG.sel=n?(SUG.sel-1+n)%n:-1; paintSug()}
  else if(e.key==="Enter"){
    e.preventDefault();
    if(SUG.sel>=0 && SUG.hits[SUG.sel]) goWord(SUG.hits[SUG.sel]);
    else commitSearch();
  }
  else if(e.key==="Escape"){ closeSug() }
}
function commitSearch(){
  var q=document.getElementById("q").value.trim().toLowerCase();
  if(!q) return;
  if(SUG.hits.length){ goWord(SUG.hits[0]); return }
  var exact=Object.keys(DB).filter(function(x){return x===q})[0];
  if(exact){ goWord(exact); return }
  toast('词库里还没有 "'+q+'"，可在单词页点「+ 新增意思」加进来');
}
function closeSug(){ document.getElementById("sug").className="sug" }

document.addEventListener("click",function(e){
  if(!e.target.closest(".box")) closeSug();
  var it=e.target.closest(".sug .i");
  if(it) goWord(it.dataset.w);
  if(e.target && e.target.id==="sugNew") toast("新增这个词");
});

/* ── 首页 ── */
function roll(){
  var ws=Object.keys(DB), w=ws[Math.floor(Math.random()*ws.length)];
  var withSn=DB[w].s.filter(function(x){return x.sn.length});
  var s=withSn.length?withSn[Math.floor(Math.random()*withSn.length)]:DB[w].s[0];
  var stem=w.replace(/[-\\^$*+?.()|[\]{}]/g,"\\$&");
  var sn=s.sn[0] ? s.sn[0].en.replace(new RegExp("\\b("+stem+"[a-z]*)\\b","ig"),
        function(m){return "<mark>"+m+"</mark>"}) : (w+" ...");
  var st=document.getElementById("stage");
  st.innerHTML='<div class="w">'+esc(w)+'</div>'
    +'<div class="sn">'+sn+'</div>'
    +'<div class="tap">点击句子进入 · '+DB[w].s.length+' 个意思</div>';
  st.onclick=function(){ goWord(w) };
}

/* ── 视图切换 ── */
function show(v){
  Array.prototype.forEach.call(document.querySelectorAll(".v"),function(x){x.classList.remove("on")});
  document.getElementById("v-"+v).classList.add("on");
  Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"),function(x){x.classList.remove("on")});
  var b=document.querySelector('.tabbar button[data-v="'+v+'"]');
  if(b) b.classList.add("on");
  window.scrollTo(0,0);
}
function go(v){ show(v) }

document.querySelectorAll(".tabbar button").forEach(function(b){
  b.onclick=function(){
    show(b.dataset.v);
    if(b.dataset.v==="lib") renderLib();
    if(b.dataset.v==="train") renderTrain();
    if(b.dataset.v==="board") renderBoard();
    if(b.dataset.v==="more") renderMore();
  };
});

/* ── 单词页 ── */
function goWord(w){
  if(!DB[w]){ toast("词库里还没有 "+w); return }
  curW=w; show("word"); renderWord();
}
function renderWord(){
  var d=DB[curW];
  document.getElementById("ttl").textContent=curW;
  document.getElementById("w-w").textContent=curW;
  document.getElementById("w-ipa").textContent=d.ipa;
  document.getElementById("w-t").textContent=d.tier;
  document.getElementById("w-n").textContent=d.s.length+" 个意思";
  document.getElementById("w-list").innerHTML=d.s.map(function(x){
    var mt=META[x.m];
    return '<div class="sl" onclick="goSense('+x.slot+')"><span class="slot">s'+x.slot+'</span>'
      +'<div class="b"><div class="g">'+esc(x.g)+'</div>'
      +'<div class="m"><span class="bar5"><i class="'+mt[3]+'" style="width:'+Math.min(100,mt[2]*20)+'%"></i></span>'
      +'<span class="tag '+mt[1]+'">'+mt[0]+'</span>'+x.reps+'次 · '+x.sn.length+'/5句'
      +(d.rf?' · <span class="badge b-rf">需精修</span>':"")+'</div></div></div>';
  }).join("");
}

/* ── 意思页 ── */
function goSense(slot){ curSlot=slot; show("sense"); renderSense() }
function renderSense(){
  var x=DB[curW].s.filter(function(y){return y.slot===curSlot})[0], mt=META[x.m];
  document.getElementById("s-back").textContent=curW;
  document.getElementById("s-slot").textContent="s"+x.slot;
  document.getElementById("s-id").textContent=x.id;
  document.getElementById("s-m").innerHTML='<span class="bar5"><i class="'+mt[3]+'" style="width:'+Math.min(100,mt[2]*20)+'%"></i></span>'
    +'<span class="tag '+mt[1]+'">'+mt[0]+'</span> '+x.reps+'次';
  document.getElementById("s-g").textContent=x.g;
  document.getElementById("s-ge").textContent=x.ge;
  document.getElementById("s-pos").textContent=x.pos;
  document.getElementById("s-note").innerHTML=x.note?'<div class="note-t">▸ '+esc(x.note)+'</div>':"";
  document.getElementById("s-cn").textContent="例句 "+x.sn.length+"/5";
  document.getElementById("s-sents").innerHTML=(x.sn.length ? x.sn.map(function(t,i){
    return '<div class="sent"><span class="n">'+(i+1)+'</span><div class="b">'
      +'<div class="en" contenteditable="true">'+esc(t.en)+'</div>'
      +'<div class="zh" contenteditable="true">'+esc(t.zh)+'</div></div>'
      +'<div class="op"><button class="ico" onclick="toast(\'已标记\')">☆</button>'
      +'<button class="ico" onclick="delSent('+i+')">✕</button></div></div>';
  }).join("") : '<div class="empty" style="padding:22px">还没有例句<br><br>点「复制给 AI」问豆包，回来的 JSON 粘回来</div>')
    + '<button class="addb" onclick="toast(\'就地添加例句\')">+ 添加例句</button>';
}
function delSent(i){
  var x=DB[curW].s.filter(function(y){return y.slot===curSlot})[0];
  x.sn.splice(i,1); renderSense(); toast("已删除");
}

/* ── 词库 ── */
function renderLib(){
  var q=(document.getElementById("q2").value||"").trim().toLowerCase(), h="";
  Object.keys(DB).forEach(function(w){
    var d=DB[w];
    if(q && w.indexOf(q)<0) return;
    if(cur==="rf" && !d.rf) return;
    if(cur==="T1" && d.tier!=="T1") return;
    if(cur==="unm" && !d.s.some(function(x){return x.m!=="mas"})) return;
    var ns=0; d.s.forEach(function(x){ if(!x.sn.length) ns++ });
    if(cur==="ns" && !ns) return;
    h+='<div class="card" onclick="goWord(\''+w+'\')" style="cursor:pointer">'
      +'<div class="rowa"><div class="sp"><b style="font-size:16px">'+esc(w)+'</b>'
      +'<span style="color:var(--ink-faint);font-size:12.5px;margin-left:7px">'+esc(d.ipa)+'</span></div>'
      +(d.rf?'<span class="badge b-rf">需精修</span>':"")
      +'<span class="badge b-ns">'+d.s.length+' 意思</span>'
      +(ns?'<span class="badge b-ns">'+ns+' 缺句</span>':'<span class="badge b-ok">句齐</span>')+'</div>'
      +'<div style="font-size:13px;color:var(--ink-soft);margin-top:6px">'+esc(d.s[0].g)+'</div></div>';
  });
  document.getElementById("l-list").innerHTML=h||'<div class="empty">没有匹配的词</div>';
}
function flt(el,k){
  Array.prototype.forEach.call(document.querySelectorAll(".chip"),function(c){c.classList.remove("on")});
  el.classList.add("on"); cur=k; renderLib();
}

/* ── 训练 ── */
var TR={q:null,i:0,n:0,revealed:false,answered:false,card:null,right:null};
function buildQueue(){
  var rank={new:0,ing:1,mas:2}, q=[];
  Object.keys(DB).forEach(function(w){
    DB[w].s.forEach(function(x){ q.push({w:w,s:x}) });
  });
  q.sort(function(a,b){ return (rank[a.s.m]-rank[b.s.m]) || (b.s.reps-a.s.reps) });
  return q.slice(0,6);
}
function renderTrain(){
  if(!TR.q) TR.q=buildQueue();
  if(TR.i>=TR.n){
    document.getElementById("t-n").textContent="完成";
    document.getElementById("t-bar").style.width="100%";
    document.getElementById("t-s").textContent="正确 4 · 错 1";
    document.getElementById("t-body").innerHTML='<div class="card">'
      +'<div class="empty" style="padding:26px">本轮完成<br><br>到期的是<b>意思对</b>，不是一个词整体</div>'
      +'<button class="btn pri blk" onclick="go(\'home\')">回首页</button></div>';
    return;
  }
  var c=TR.q[TR.i];
  TR.card=c; TR.revealed=false; TR.answered=false;
  var w=c.w, stem=w.replace(/[-\\^$*+?.()|[\]{}]/g,"\\$&");
  document.getElementById("t-n").textContent=(TR.i+1)+" / "+TR.n;
  document.getElementById("t-bar").style.width=(TR.i/TR.n*100)+"%";
  document.getElementById("t-s").textContent="到期 5 · 新卡 3";

  var head='<div class="card"><div class="qw">'+esc(w)+'</div>'
    +'<div class="qtag">'+esc(c.s.pos)+' /'+esc(DB[w].ipa)+'/ '+esc(DB[w].tier)+'</div>';
  var body;
  if(c.s.sn.length){
    var marked=c.s.sn[0].en.replace(new RegExp("\\b("+stem+"[a-z]*)\\b","ig"),
      function(m){return "<mark>"+m+"</mark>"});
    body='<div class="qsent">'+marked+'</div>'
      +'<div class="qhint">想清楚这个词在这里的意思</div>'
      +'<div class="blank" onclick="reveal()">— 点击空白处显示选项 —</div>'
      +'<div class="giveup"><a onclick="answer(\'new\')">我不会</a></div>';
  }else{
    body='<div class="empty" style="padding:26px 10px"><b>'+esc(c.s.g)+'</b><br><br>'
      +'这个意思还没有例句，无法出题。<br>'
      +'<button class="btn sm" style="margin-top:9px" onclick="goWord(\''+w+'\');goSense('+c.s.slot+')">去补例句</button></div>';
  }
  document.getElementById("t-body").innerHTML = head + body
    + '<div id="opts"></div><div id="exp"></div></div>';
}
function reveal(){
  if(TR.revealed) return;
  TR.revealed=true;
  var c=TR.card, wrong=[];
  Object.keys(DB).forEach(function(w){
    DB[w].s.forEach(function(x){ if(x.g!==c.s.g) wrong.push(x.g) });
  });
  var opts=[c.s.g].concat(wrong.slice(0,3).sort(function(){return Math.random()-.5}));
  opts.sort(function(){return Math.random()-.5});
  TR.right=c.s.g;
  var qh=document.querySelector(".qhint"); if(qh) qh.textContent="选择一个意思";
  var bl=document.querySelector(".blank"); if(bl) bl.style.display="none";
  var gu=document.querySelector(".giveup"); if(gu) gu.style.display="none";
  document.getElementById("opts").innerHTML=opts.map(function(z,i){
    return '<div class="opt" onclick="answer(\''+(z===TR.right?"right":"wrong")+'\',this)">'
      +'<span class="key">'+"ABCD"[i]+'</span><span>'+esc(z)+'</span></div>';
  }).join("") + '<div class="opt full" onclick="answer(\'new\')"><span class="key">E</span><span>我不会</span></div>';
}
function answer(kind,node){
  if(TR.answered) return;
  TR.answered=true;
  var c=TR.card;
  if(node) node.classList.add(kind==="right"?"right":"wrong");
  var st = kind==="right" ? ["ok","✓ 正确"] : kind==="new" ? ["sk","· 我不会"] : ["no","✕ 答错"];
  document.getElementById("opts").innerHTML="";
  document.getElementById("exp").innerHTML=
    '<div class="exp"><div class="st '+st[0]+'">'+st[1]+'</div>'
    +'<div class="ln"><b>正确答案：</b>'+esc(c.s.g)+'</div>'
    +(c.s.note ? '<div class="ln" style="color:#92400e">'+esc(c.s.note)+'</div>' : "")
    +(c.s.sn.length ? '<div class="ln" style="color:var(--ink-soft);font-size:12.5px">'
        + esc(c.s.sn[0].en)+'<br>'+esc(c.s.sn[0].zh)+'</div>' : "")
    +'<div class="rowa" style="margin-top:10px">'
    +'<button class="btn sm" onclick="toast(\'已标记学会\')">我已学会</button>'
    +'<button class="btn sm" onclick="goWord(\''+c.w+'\')">看这个词</button>'
    +'<span class="sp"></span>'
    +'<button class="btn pri sm" onclick="TR.i++;renderTrain()">下一题</button></div>'
    +'<div class="flagbox"><span style="font-size:12.5px;white-space:nowrap">这句有问题？</span>'
    +'<input placeholder="备注（可空）">'
    +'<button class="btn sm" onclick="toast(\'已标记，不再出现\')">提交</button></div>'
    +'<div style="font-size:11.5px;color:var(--ink-faint);margin-top:7px">'
    +'标记的句子不会再出现；下一题不会自动提交。</div></div>';
}

/* 看板：意思对状态表 + 错题板
   记忆曲线是机制，不是界面。用户要的是「我大概掌握了吗」和
   「它为什么又出现」，不是 stability 2.34 这种数字。所以这里显示
   状态 + 下次复习时间，让 SRS 排期可见可解释。 */
function nextDue(x){
  if(x.m==="mas") return [x.reps>=14 ? "已稳固" : "已掌握",
                         "var(--good-soft)", "#047857"];
  if(x.m==="ing") return [x.due||"明天", "#fef3c7", "#b45309"];
  return ["已到期", "var(--bad-soft)", "#b91c1c"];
}
function renderBoard(){
  var wrongs=[], states=[], cnt=0;
  Object.keys(DB).forEach(function(w){
    DB[w].s.forEach(function(x){
      var due = x.due || (x.m==="mas" ? (3+x.slot)+"天后"
                       : x.m==="ing" ? "明天" : "已到期");
      states.push({w:w, s:x, due:due});
      if(x.m!=="mas"){ cnt++; wrongs.push({w:w, s:x}); }
    });
  });
  states.sort(function(a,b){
    var rank={new:0,ing:1,mas:2};
    return (rank[a.s.m]-rank[b.s.m]) || (a.s.reps-b.s.reps);
  });

  var h='<div class="hint">同一个词的不同意思是<b>两条独立的记忆曲线</b>。<br>'
    +'「下次复习」来自 SRS 排期，不是手工设的 —— 它解释了这个意思为什么又出现。</div>';

  h+='<div class="card" style="padding:0;overflow:hidden">'
    +'<div style="padding:11px 13px;background:#fafbff;border-bottom:1px solid var(--line);font-size:13.5px;font-weight:650">'
    +'意思对状态表（'+states.length+' 条）</div>';
  states.forEach(function(r){
    var x=r.s, mt=META[x.m], d=nextDue(x);
    h+='<div class="sl" style="margin:0;border:0;border-bottom:1px solid #f6f7fb;border-radius:0;padding:10px 13px">'
      +'<span class="slot">s'+x.slot+'</span><div class="b">'
      +'<div class="g" style="font-size:14px"><b>'+esc(r.w)+'</b> '
      +'<span style="font-weight:400;color:var(--ink-soft)">'+esc(x.g)+'</span></div>'
      +'<div class="m"><span class="bar5"><i class="'+mt[3]+'" style="width:'+Math.min(100,mt[2]*20)+'%"></i></span>'
      +'<span class="tag '+mt[1]+'">'+mt[0]+'</span>'+x.reps+'次'
      +'<span class="badge" style="background:'+d[1]+';color:'+d[2]+'">下次 '+esc(r.due)+'</span>'
      +(x.sn.length?'':'<span class="badge b-ns">缺例句</span>')+'</div></div></div>';
  });
  h+='</div>';

  h+='<div class="card" style="padding:0;overflow:hidden;margin-top:12px">'
    +'<div style="padding:11px 13px;background:#fafbff;border-bottom:1px solid var(--line);font-size:13.5px;font-weight:650">'
    +'错题板（'+cnt+' 个意思待攻克）'
    +'<span style="font-weight:400;color:var(--ink-faint);font-size:11.5px;margin-left:8px">单挑入口只在这里</span></div>';
  if(!cnt){
    h+='<div class="empty" style="padding:24px">错题板是空的</div>';
  } else {
    wrongs.forEach(function(r){
      var x=r.s, mt=META[x.m];
      h+='<div class="sl" style="margin:0;border:0;border-bottom:1px solid #f6f7fb;border-radius:0;padding:10px 13px">'
        +'<span class="slot">s'+x.slot+'</span><div class="b">'
        +'<div class="g" style="font-size:14px"><b>'+esc(r.w)+'</b> '
        +'<span style="font-weight:400;color:var(--ink-soft)">'+esc(x.g)+'</span></div>'
        +'<div class="m"><span class="tag '+mt[1]+'">'+mt[0]+'</span>'+x.reps+'次 · '
        +'<span style="color:var(--bad)">连对 2 次移出</span></div></div>'
        +'<button class="btn sm pri" onclick="toast(SOLO_MSG)">单挑</button></div>';
    });
  }
  h+='</div>';
  document.getElementById("b-list").innerHTML=h;
}

function copyTpl(w,slot){
  var d=DB[w]; if(!d) return;
  var ss=slot?[d.s.filter(function(x){return x.slot===slot})[0]]:d.s;
  var t="单词: "+w+"\n音标: "+d.ipa+"\n\n";
  ss.forEach(function(x){
    t+="-- 意思 s"+x.slot+" --\n中文释义: "+x.g+"\n英文释义: "+x.ge+"\n"
      +(x.note?"备注: "+x.note+"\n":"")+"\n";
  });
  t+="请核验并补全：\n"
   +"1. 上述中文释义是否准确？不准确请给出更好的。\n"
   +"2. 为每个意思各造 5 个英文例句 + 中文翻译，每句必须能体现该意思的独特用法。\n"
   +"3. 只输出下面这个 JSON：\n\n"
   +'{"word":"'+w+'","senses":['
   +ss.map(function(x){
       return '{\n  "slot":'+x.slot+',\n  "gloss":"...",\n'
         +'  "sentences":[{"en":"...","zh":"..."}]\n}'}).join(",\n")
   +"]}";
  document.getElementById("ct").textContent="复制模板 · "+w;
  document.getElementById("ctxt").value=t;
  open("m-copy");
}
function cp(){ var t=document.getElementById("ctxt"); t.select(); try{document.execCommand("copy")}catch(e){} }
function openImp(){ open("m-imp") }

function renderMore(){
  document.getElementById("m-st").innerHTML=
    '<div><b>2998</b><span>词</span></div><div><b>9210</b><span>意思对</span></div>'
    +'<div><b>340</b><span>已学</span></div><div><b>2655</b><span>需精修</span></div>';
}
function open(i){ document.getElementById(i).classList.add("on") }
function close(i){ document.getElementById(i).classList.remove("on") }
function toast(m){ alert("原型提示\n\n"+m) }

roll();
renderMore();
