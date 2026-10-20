// Generated from published 0.2.6053 (6b7d3c6e5862d3f466ce91c734ffc13eaab3bc47).
// Frozen scan + pure dependencies; mock session/page; never shipped.
module.exports = {baselineCommit:"6b7d3c6e5862d3f466ce91c734ffc13eaab3bc47",factory:(function(schedule){
    var window={},state,yields=0,options;
    var IR_HOVER_LINK_SKIP={'class':1,'def':1,'if':1,'else':1,'elif':1,'for':1,'while':1,'return':1,'import':1,'from':1,'as':1,'with':1,'try':1,'except':1,'finally':1,'raise':1,'pass':1,'break':1,'continue':1,'and':1,'or':1,'not':1,'is':1,'in':1,'lambda':1,'yield':1,'async':1,'await':1,'var':1,'let':1,'const':1,'function':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'void':1,'this':1,'self':1,'cls':1,'switch':1,'case':1,'default':1,'throw':1,'catch':1,'export':1,'extends':1,'implements':1,'interface':1,'enum':1,'abstract':1,'static':1,'public':1,'private':1,'protected':1,'readonly':1,'override':1,'struct':1,'union':1,'typedef':1,'extern':1,'register':1,'signed':1,'unsigned':1,'auto':1,'goto':1,'include':1,'define':1,'ifdef':1,'endif':1,'pragma':1,'namespace':1,'using':1,'template':1,'virtual':1,'inline':1,'constexpr':1,'nullptr':1,'the':1,'The':1,'that':1,'will':1,'are':1,'was':1,'has':1,'have':1,'can':1,'should':1,'may':1,'must':1,'been':1,'being':1,'does':1,'did':1,'its':1,'also':1,'than':1,'then':1,'when':1,'where':1,'which':1,'what':1,'how':1,'who':1,'all':1,'each':1,'every':1,'some':1,'any':1,'Returns':1,'Raises':1,'Args':1,'Parameters':1,'Note':1,'Example':1,'param':1,'throws':1,'since':1,'see':1,'deprecated':1,'alias':1,'overload':1,'module':1,'variable':1,'None':1,'True':1,'False':1,'Cannot':1,'Could':1,'Would':1,'Should':1,'This':1,'That':1,'These':1,'Those':1,'Here':1,'There':1,'Warning':1,'Warnings':1,'See':1,'Also':1,'More':1,'Given':1,'Available':1,'Required':1,'Reference':1,'Examples':1};
    var IR_HOVER_EAGER_WRAP_MAX_TEXT=4000;
    function irTypeShapedName(w){return /^[A-Z][A-Za-z0-9_]*$/.test(w)||/^_[A-Z][A-Z0-9_]*$/.test(w)}
function irConstantHoverLinkName(w){return /^_*[A-Z][A-Z0-9_]*$/.test(w)}
function irLowerCallableName(w){return /^[a-z_$][A-Za-z0-9_$]*$/.test(w)}
function irEscapeHoverLinkRegex(w){
  return String(w||'').replace(/[\^$.*+?()[\]{}|]/g,'\\$&');
}
    function irDetachedHoverStateForSessionKey(){return state;}
    function irDetachedSymbolPickerIsCurrent(s,p){return !!(s&&s.symbolPicker===p&&!s.previewBusy&&s.previewRequestSeq===p.requestId);}
    function irClearTimer(){}
    function setTimeout(fn){yields++;if(options.cancelAtYield===yields)state.symbolPicker=null;return schedule(fn);}
    var scan=async function(sessionKey,pickerId,queryId,query){
  var state=irDetachedHoverStateForSessionKey(sessionKey),picker=state&&state.symbolPicker;
  if(!picker||picker.id!==Number(pickerId)||!irDetachedSymbolPickerIsCurrent(state,picker))return {ok:false,reason:'stale-picker'};
  queryId=Number(queryId)||0;
  if(queryId<=picker.queryId)return {ok:false,reason:'stale-query'};
  picker.queryId=queryId;
  if(picker.timer){irClearTimer(picker.timer);picker.timer=null;}
  picker.names=[];
  query=String(query||'').trim().toLowerCase();
  var names=[],seen=Object.create(null),more=false;
  var known=picker.target.__irHoverLinkCandidates||{};
  function add(name){
    if(!name||name.length<=2||IR_HOVER_LINK_SKIP[name]||seen[name]||name===state.currentTypeName
      ||(query&&name.toLowerCase().indexOf(query)<0))return;
    seen[name]=1;
    if(names.length<200)names.push(name);else more=true;
  }
  var seeds=picker.target.__irDetachedLinkTypes||[];
  for(var si=0;si<seeds.length;si++)add(seeds[si]);
  var text=picker.text,re=/[A-Za-z_$][A-Za-z0-9_$]*/g,m,chunkEnd=0;
  // Selection is explicit, so scan the complete page, including the tail beyond
  // pointer indexing's prefix. Yield without walking/measuring/mutating tokens.
  while(!more&&(m=re.exec(text))!==null){
    if(re.lastIndex>chunkEnd){
      await new Promise(function(resolve){setTimeout(resolve,0);});
      if(!irDetachedSymbolPickerIsCurrent(state,picker)||picker.queryId!==queryId)return {ok:false,reason:'stale-picker'};
      chunkEnd=re.lastIndex+32768;
    }
    var name=m[0],before=m.index?text.charAt(m.index-1):'';
    if(/[A-Za-z0-9_$]/.test(before))continue;
    if(query&&name.toLowerCase().indexOf(query)<0)continue;
    var callable=irLowerCallableName(name)&&(/^\s*\(/.test(text.slice(re.lastIndex,re.lastIndex+32))
      ||/@\s*$/.test(text.slice(Math.max(0,m.index-16),m.index))
      ||/(?:^|\s)(?:def|function)\s+$/.test(text.slice(Math.max(0,m.index-48),m.index)));
    if(known[name]||irTypeShapedName(name)||irConstantHoverLinkName(name)||callable)add(name);
  }
  if(!irDetachedSymbolPickerIsCurrent(state,picker)||picker.queryId!==queryId)return {ok:false,reason:'stale-picker'};
  picker.names=names;
  return {ok:true,names:names,more:more};
};
    return async function(input){
      options=input;yields=0;
      var target={__irHoverLinkCandidates:input.known||{},__irDetachedLinkTypes:input.seeds||[]};
      state={el:{isConnected:true},previewRequestSeq:0,previewBusy:false,currentTypeName:input.current||'',
        symbolPicker:{id:1,requestId:0,target:target,text:input.text,queryId:0,names:[],timer:null}};
      var result=await scan('benchmark',1,1,input.query);
      return {result:result,yields:yields};
    };
  })};
