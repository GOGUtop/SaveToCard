/* Save to Card - Revenge Classic experimental media-menu plugin.
 * This file is embedded as a plain script in Revenge Classic (bunny, definePlugin).
 * Never reads Discord auth tokens or messages. Only uploads on explicit action.
 */
var plugin = (function () {
  'use strict';
  var ID = 'cardvault.save-to-card';
  var TITLE = '保存到 Card';
  var DEFAULT_SERVER = 'http://aaa.xixisillytavern.top:8788';
  var MAX_SIZE = 30 * 1024 * 1024;
  var unpatches = [];
  var reports = { started: false, patches: [], injected: 0, last: '尚未捕获图片菜单', error: '' };
  var config = { server: DEFAULT_SERVER, username: '', password: '', allowHttp: false, onlyCharacter: true };
  var store = null;
  var token = '';
  var busy = false;

  function runtime() { return typeof bunny !== 'undefined' ? bunny : (typeof window !== 'undefined' ? window.bunny : null); }
  function log(s) { try { console.log('[SaveToCard]', s); } catch (_) {} }
  function notify(s) {
    reports.last = String(s);
    log(s);
    try {
      var b = runtime();
      var toast = b && b.ui && b.ui.toasts && b.ui.toasts.showToast;
      if (typeof toast === 'function') toast(String(s));
    } catch (_) {}
  }
  function getMetro() { var b = runtime(); return b && (b.metro || (b.api && b.api.metro)); }
  function getReact() {
    var metro = getMetro();
    return metro && metro.common && metro.common.React || (runtime() && runtime().react && runtime().react.React);
  }
  function getRN() {
    var metro = getMetro();
    return metro && metro.common && metro.common.ReactNative;
  }
  function syncSettings() {
    if (!store) return;
    for (var k in config) if (store[k] !== undefined) config[k] = store[k];
  }
  function persist(key, value) {
    config[key] = value;
    if (store) { try { store[key] = value; } catch (e) { log('store: ' + e); } }
  }
  function normalizeServer(v) {
    var s = String(v || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+(?::\d+)?$/i.test(s)) throw Error('网站地址格式不正确，只允许 http(s)://主机[:端口]');
    if (/^http:\/\//i.test(s) && !config.allowHttp) throw Error('HTTP 明文上传已禁用，请在设置中明确允许');
    return s;
  }
  function sourceURL(input) {
    if (typeof input !== 'string') return '';
    var u; try { u = new URL(input); } catch (_) { return ''; }
    if (u.protocol !== 'https:' || u.hostname !== 'cdn.discordapp.com') return '';
    if (!/^\/(?:attachments|ephemeral-attachments)\//.test(u.pathname)) return '';
    // Media proxy or resized WebP is not a valid character-card source.
    if (!/\.png$/i.test(decodeURIComponent(u.pathname))) return '';
    return u.href;
  }
  function findOriginalURL(args, rendered) {
    var seen = new Set();
    var results = [];
    function collect(value, depth, key) {
      if (depth > 6 || value == null || results.length > 64) return;
      if (typeof value === 'string') {
        var u = sourceURL(value);
        if (u) results.push({ url: u, key: key || '' });
        return;
      }
      if (typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { for (var i = 0; i < Math.min(10, value.length); i++) collect(value[i], depth+1, key); return; }
      var keys = Object.keys(value);
      for (var j=0; j<Math.min(keys.length, 35); j++) {
        var k=keys[j];
        if (/^(url|uri|proxy_url|imageUrl|originalUrl|originalURL|source|src|attachment|attachments|media|item|image|props|message|data|selectedMedia|asset)$/i.test(k)) collect(value[k], depth+1, k);
      }
    }
    collect(args, 0, 'args');
    collect(rendered && rendered.props, 0, 'rendered');
    // For a single viewed attachment, multiple candidate URLs are ambiguous: do not upload the wrong image.
    var distinct = Array.from(new Set(results.map(function (r) { return r.url; })));
    return distinct.length === 1 ? distinct[0] : '';
  }
  function utf8(bytes, start, end) {
    try { return new TextDecoder('utf-8').decode(bytes.subarray(start,end)); }
    catch (_) { var s = ''; for (var i=start;i<end;i++) s += String.fromCharCode(bytes[i]); return s; }
  }
  function pngHasCard(bytes) {
    var sig=[137,80,78,71,13,10,26,10];
    if (bytes.length < 8 || sig.some(function (n,i) { return bytes[i] !== n; })) throw Error('原始附件不是 PNG 文件');
    var off=8;
    while (off+12 <= bytes.length) {
      var len=((bytes[off]*16777216)+(bytes[off+1]<<16)+(bytes[off+2]<<8)+bytes[off+3])>>>0;
      if (len > bytes.length-off-12) throw Error('PNG 数据块长度异常');
      var type=utf8(bytes,off+4,off+8);
      if (type==='tEXt'||type==='iTXt'||type==='zTXt') {
        var end=Math.min(off+8+len,off+80), zero=off+8;
        while (zero<end && bytes[zero]!==0) zero++;
        var keyword=utf8(bytes,off+8,zero).toLowerCase();
        if (keyword==='chara'||keyword==='ccv3') return true;
      }
      off+=12+len;
      if (type==='IEND') break;
    }
    return false;
  }
  async function fetchWithTimeout(url, init) {
    // Network timeouts depend on host environment; no AbortSignal guaranteed on Hermes.
    return fetch(url, init);
  }
  async function upload(url) {
    if (busy) return notify('有另一张角色卡正在上传');
    busy = true;
    try {
      syncSettings();
      var base=normalizeServer(config.server);
      if (!config.username || !config.password) throw Error('先在插件设置中填写 CardVault 账号和密码');
      var src=sourceURL(url);
      if (!src) throw Error('没有找到可信的 Discord PNG 原始附件地址，已取消上传');
      notify('正在读取 PNG 原文件…');
      var response=await fetchWithTimeout(src,{ method:'GET' });
      if (!response.ok) throw Error('下载 PNG 失败：HTTP '+response.status);
      var declared=Number(response.headers && response.headers.get && response.headers.get('content-length') || 0);
      if (declared>MAX_SIZE) throw Error('PNG 超过 30MB 上限');
      var raw=await response.arrayBuffer();
      if (raw.byteLength>MAX_SIZE) throw Error('PNG 超过 30MB 上限');
      var card=pngHasCard(new Uint8Array(raw));
      if (!card && config.onlyCharacter) throw Error('PNG 没有 chara/ccv3 元数据，已跳过');
      notify('正在登录 CardVault…');
      var login=await fetchWithTimeout(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:config.username,password:config.password})});
      if (!login.ok) throw Error('CardVault 登录失败：HTTP '+login.status);
      var json=await login.json();
      token=json && (json.token || json.data && json.data.token);
      if (typeof token!=='string'||!token) throw Error('登录响应缺少 token');
      var path=new URL(src).pathname;
      var name=decodeURIComponent(path.slice(path.lastIndexOf('/')+1)) || 'discord-card.png';
      name=name.replace(/[\r\n]/g,'').slice(0,180);
      notify('正在上传到 CardVault…');
      var res=await fetchWithTimeout(base+'/api/cards/import',{method:'POST',headers:{'Content-Type':'image/png','Authorization':'Bearer '+token,'X-File-Name':name},body:raw});
      if (!res.ok) throw Error('导入失败：HTTP '+res.status+' '+(await res.text()).slice(0,100));
      notify('已保存到 Card：'+name);
    } catch (e) {
      reports.error=String(e && e.message || e);
      notify('保存到 Card 失败：'+reports.error);
    } finally { token='';busy=false; }
  }
  function rowLabel(el) {
    if (!el || typeof el !== 'object') return '';
    var p=el.props || {};
    return typeof p.label==='string' ? p.label : (typeof p.text==='string' ? p.text : '');
  }
  function isSave(label) { return /^(保存|Save|Save Image|Save Media|Download)$/i.test(label); }
  function isForward(label) { return /^(转发|Forward)$/i.test(label); }
  function isShare(label) { return /^(分享|Share)$/i.test(label); }
  function insertBesideSave(root, onClick) {
    var React=getReact();
    if (!React || !React.cloneElement || !root) return false;
    var seen=new Set();
    function visit(node, depth) {
      if (depth>15 || !node || typeof node!=='object'||seen.has(node)) return false;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.some(function(x){ return rowLabel(x)===TITLE; })) return false;
        // Never modify unrelated menus: verify neighbouring Forward + Share when present.
        var at=node.findIndex(function(x){return isSave(rowLabel(x));});
        if (at>=0) {
          var save=node[at];
          var clone=React.cloneElement(save,{ key:'cardvault-save-action',label:TITLE,text:TITLE,onPress:onClick,onClick:onClick });
          node.splice(at+1,0,clone);
          return true;
        }
        for (var i=0;i<node.length;i++) if (visit(node[i],depth+1)) return true;
      } else if (node.props) {
        if (visit(node.props.children,depth+1)) return true;
      }
      return false;
    }
    return visit(root,0);
  }
  function countActionLabels(root) {
    var flags={save:false,forward:false,share:false};var seen=new Set();
    function scan(node, depth) {
      if (!node || depth>16||typeof node!=='object'||seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(function(x){scan(x,depth+1);});return; }
      var label=rowLabel(node);
      if (isSave(label)) flags.save=true;
      if (isForward(label)) flags.forward=true;
      if (isShare(label)) flags.share=true;
      if (node.props) scan(node.props.children,depth+1);
    }
    scan(root,0);return flags;
  }
  function patchOne(name) {
    var b=runtime(), metro=getMetro(), patcher=b&&b.api&&b.api.patcher;
    if (!metro||!patcher||typeof patcher.after!=='function') return false;
    var finder=metro.findByName || (metro.filters&&metro.filters.findByName);
    if (typeof finder!=='function') return false;
    var mod;
    try { mod=finder(name,false); } catch (_) { return false; }
    if (!mod||typeof mod.default!=='function') return false;
    var dispose=patcher.after('default',mod,function(args,tree){
      try {
        var labels=countActionLabels(tree);
        if (!labels.save||!(labels.forward||labels.share)) return tree;
        var url=findOriginalURL(args,tree);
        if (!url) { reports.last='发现图片菜单，但原图 URL 尚未定位'; return tree; }
        if (insertBesideSave(tree,function(){ upload(url); })) {
          reports.injected++;
          reports.last='已向图片菜单插入按钮';
        }
      } catch (e) { reports.error=String(e);log('menu patch failed: '+e); }
      return tree;
    });
    unpatches.push(dispose);
    reports.patches.push(name);
    return true;
  }
  function SettingsComponent() {
    var R=getReact(), RN=getRN();
    if (!R||!RN||!RN.ScrollView||!RN.TextInput||!RN.Text||!RN.Switch) return null;
    var h=R.createElement;
    var state=R.useState?R.useState(Object.assign({}, config)):[Object.assign({},config),function(){}];
    var values=state[0],setValues=state[1];
    function change(k,v){persist(k,v);setValues(function(prev){return Object.assign({},prev,{[k]:v});});}
    var fields=[
      ['server','CardVault 地址',false],['username','用户名',false],['password','密码（保存在 Revenge 插件存储中）',true]
    ];
    var label={color:'#d8d9ed',fontSize:14,marginTop:16,marginBottom:5};
    var input={color:'#ffffff',backgroundColor:'#414450',borderRadius:8,paddingHorizontal:12,paddingVertical:10};
    return h(RN.ScrollView,{style:{flex:1},contentContainerStyle:{padding:18,paddingBottom:50}},
      h(RN.Text,{style:{color:'#f7f7fb',fontSize:19,fontWeight:'bold'}},'保存到 Card · Classic v0.3'),
      h(RN.Text,{style:{color:'#c6c8d3',marginTop:8}},'请只用你自己的 CardVault 凭据；不读取 Discord Token。'),
      ...fields.flatMap(function(f){return [
        h(RN.Text,{key:'l-'+f[0],style:label},f[1]),
        h(RN.TextInput,{key:'i-'+f[0],style:input,value:values[f[0]],onChangeText:function(v){change(f[0],v);},secureTextEntry:f[2],autoCapitalize:'none',autoCorrect:false})
      ];}),
      h(RN.Text,{style:label},'允许 HTTP 明文传输（有账号密码泄露风险）'),
      h(RN.Switch,{value:!!values.allowHttp,onValueChange:function(v){change('allowHttp',v);}}),
      h(RN.Text,{style:label},'仅上传 chara / ccv3 角色卡 PNG'),
      h(RN.Switch,{value:!!values.onlyCharacter,onValueChange:function(v){change('onlyCharacter',v);}}),
      h(RN.Text,{style:{color:'#b1c2dd',marginTop:20}},'启动状态：'+(reports.started?'已执行 start()':'未启动')),
      h(RN.Text,{style:{color:'#b1c2dd',marginTop:8}},'运行接口：bunny='+!!runtime()+', metro='+!!getMetro()+', patcher='+!!(runtime()&&runtime().api&&runtime().api.patcher)+', storage='+!!store),
      h(RN.Text,{style:{color:'#b1c2dd',marginTop:8}},'已找到菜单补丁：'+(reports.patches.join(', ')||'无（需要适配 Discord 351.11）')),
      h(RN.Text,{style:{color:'#b1c2dd',marginTop:8}},'菜单注入次数：'+reports.injected),
      h(RN.Text,{style:{color:'#b1c2dd',marginTop:8}},'状态：'+reports.last),
      h(RN.Text,{style:{color:'#f6a0a0',marginTop:8}},reports.error)
    );
  }
  return {
    start:function(){
      try {
        var b=runtime();
        reports.started = true;
        reports.last = '已执行 start()';
        if (b && b.plugin && typeof b.plugin.createStorage==='function') {
          store=b.plugin.createStorage();
          syncSettings();
        }
        var names=['MediaViewerActionSheet','MediaActionSheet','ImageActionSheet','MediaViewerContextMenu','AttachmentActionSheet','MediaOptionsActionSheet','MediaViewerActions','MediaViewerOptions','MediaViewerMenu'];
        names.forEach(patchOne);
        notify('SaveToCard 已启动；菜单适配点：'+reports.patches.length);
      } catch (e) { reports.error=String(e);log(e); }
    },
    stop:function(){reports.started=false;unpatches.splice(0).forEach(function(f){try{f();}catch(_){}});token='';},
    SettingsComponent:SettingsComponent,
    __test:{sourceURL:sourceURL,pngHasCard:pngHasCard,findOriginalURL:findOriginalURL,insertBesideSave:insertBesideSave,upload:upload,config:config,reports:reports}
  };
})();
