(() => {
  'use strict';
  // Revenge 0980cfc > Install a plugin uses the Vendetta eval expression format.
  const v = vendetta;
  const MAX_BYTES = 30 * 1024 * 1024;
  const MAX_CONTEXT_AGE_MS = 60 * 1000;
  const state = {
    viewerTrackingAt: 0, jsxSourcesSeen: 0, started: false, sheetHook: false, viewerHooks: [], jsxHooks: [], jsxCalls: 0, jsxMenuMatches: 0, lazyCalls: 0, sheets: 0, menuMatches: 0,
    renderMediaHooks: [], renderMediaCalls: 0, renderMediaURLs: 0, renderMediaAmbiguous: false, mediaType: '', sourceReason: '',
    injections: 0, clicks: 0, uploads: 0, contextUrl: '', contextAt: 0, renderMediaURL: '', viewerSources: [],
    browserAttempts: 0, browserCaptures: 0, browserHookNames: [], browserReason: '', lastSourcePath: '',
    last: '尚未啟動', error: '', lastUpload: ''
  };
  const cleanups = [];
  const config = {server: 'http://aaa.xixisillytavern.top:8788', username: '', password: '', allowHttp: false, onlyCard: true};
  let busy = false;
  const text = x => String(x == null ? '' : x).slice(0, 300);
  const logger = s => { try { v.logger?.log?.('[SaveToCard] ' + text(s)); } catch (_) {} };
  const toast = s => { state.last = text(s); try { v.ui?.toasts?.showToast?.(text(s)); } catch (_) { logger(s); } };
  const store = v.plugin && v.plugin.storage || null;
  for (const k of Object.keys(config)) {
    if (store && typeof store[k] === typeof config[k]) config[k] = store[k];
  }
  // The supplied Windows CardVault importer only imports raw PNG character cards.
  // Prior 'allow all images' setting is deliberately disabled for protocol fidelity.
  config.onlyCard = true;
  if (store) { try { store.onlyCard = true; } catch (_) {} }
  const saveConfig = (key, value) => {
    if (!Object.prototype.hasOwnProperty.call(config, key)) return;
    config[key] = value;
    if (key === 'onlyCard') value = true;
    if (store) { try { store[key] = value; } catch (e) { state.error = '保存設定失敗: ' + text(e); } }
  };
  const reportError = e => { state.error = text(e && e.message ? e.message : e); logger(state.error); };
  // Accept the current Discord image as-is: PNG, JPEG, WebP, GIF or AVIF.
  // A picture still needs a source to transfer bytes; no filename restriction.
  const fileURL = candidate => {
    const rec = mediaRecord(candidate);
    return rec ? rec.url : '';
  };
  const mimeOf = bytes => {
    if (bytes.length >= 8 && bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71 && bytes[4]===13 && bytes[5]===10) return 'image/png';
    if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP') return 'image/webp';
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0,3))==='GIF') return 'image/gif';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4,8))==='ftyp' && /avif|avis/.test(String.fromCharCode(...bytes.slice(8,12)))) return 'image/avif';
    throw Error('下載的檔案不是可辨識的圖片');
  };
  // Native Save fallback: ask Discord's own Save action for the attachment,
  // observe its MediaManager.downloadMediaAsset call, then transfer those bytes.
  let waitingSave = null;
  const nativeDownload = {hook:false,captures:0};
  const installSaveCapture = () => {
    const names=['downloadMediaAsset','downloadMedia','saveMediaAsset'];
    for(const method of names){
      let module;
      try {module=v.metro?.findByProps?.(method);} catch (_) {}
      if(!module || typeof module[method]!=='function') continue;
      try {
        const off=v.patcher?.before?.(method,module,args=>{
          if(!waitingSave) return;
          const candidates=mediaRecords(args,6);
          if(candidates.length!==1) return;
          nativeDownload.captures++;
          const current=waitingSave;
          waitingSave=null;
          current.resolve(candidates[0].url);
        });
        if(typeof off==='function'){cleanups.push(off);nativeDownload.hook=true;}
      } catch(e){reportError(e);}
    }
  };
  const originalAction = (obj,depth=0) => {
    if(!obj || depth>6 || typeof obj!=='object') return null;
    const p=obj.props && typeof obj.props==='object' ? obj.props : obj;
    for (const k of ['onPress','onClick','onSelect','action','callback','onActivate']) {
      if(typeof p[k]==='function') return {fn:p[k], receiver:p};
    }
    if(Array.isArray(p.children)) {
      for(const child of p.children){const found=originalAction(child,depth+1);if(found)return found;}
    } else if(p.children) return originalAction(p.children,depth+1);
    return null;
  };
  // Browser-link extraction: the image popup already includes a native
  // "Open in Browser" action whose closure knows the media URL. Rather than
  // guessing message attachments or opening an external browser, temporarily
  // intercept the URL-opening bridge while invoking *that menu item*.
  // Never call it unless at least one URL bridge is intercepted.
  const browserOpenerModules = () => {
    const found=[], seen=new Set();
    const register=(obj,method,label)=>{
      if(!obj || typeof obj[method]!=='function')return;
      if(seen.has(obj)){
        if(found.some(entry=>entry.obj===obj&&entry.method===method))return;
      }
      seen.add(obj);found.push({obj,method,label});
    };
    const common=v.metro?.common||{};
    register(common.ReactNative?.Linking,'openURL','ReactNative.Linking.openURL');
    register(common.url,'openURL','common.url.openURL');
    register(common.url,'openExternalURL','common.url.openExternalURL');
    register(common.url,'openInBrowser','common.url.openInBrowser');
    const lookups=[
      ['openURL'],['openExternalURL'],['openExternalLink'],['openInBrowser'],
      ['openLink'],['openExternalBrowser'],['openMediaInBrowser']
    ];
    for(const keys of lookups){
      try {
        const mod=v.metro?.findByProps?.(...keys);
        for(const key of keys)register(mod,key,'metro.'+key);
      }catch(_){}
    }
    return found;
  };
  const captureFromBrowserAction = nativeBrowser => {
    if (!nativeBrowser || typeof nativeBrowser.fn!=='function') {
      state.browserReason='圖片選單沒有可呼叫的「在瀏覽器中開啟」動作';
      return Promise.resolve('');
    }
    if(typeof v.patcher?.instead!=='function'){
      state.browserReason='Revenge 未提供 instead 攔截接口';
      return Promise.resolve('');
    }
    state.browserAttempts++;
    return new Promise(resolve => {
      let completed=false, timer=null, unknown='';
      const unpatches=[];
      const finish=(url,why)=>{
        if(completed)return;
        completed=true;
        if(timer!=null)clearTimeout(timer);
        while(unpatches.length){try{unpatches.pop()();}catch(_){}}
        if(why)state.browserReason=why;
        if(url){state.browserCaptures++;state.lastSourcePath='瀏覽器菜單 URL 攔截';}
        resolve(url||'');
      };
      for(const {obj,method,label} of browserOpenerModules()){
        try{
          const unpatch=v.patcher.instead(method,obj,(args,original)=>{
            // This branch only runs while explicitly handling Card's own tap.
            // The external browser must not be launched as a side effect.
            const urls=mediaRecords(args,4);
            if(urls.length===1){
              state.sourceReason='「在瀏覽器中開啟」動作';
              const exact=urls[0].url;
              Promise.resolve().then(()=>finish(exact,'取得原始附件網址'));
            } else if(urls.length>1){
              unknown='「在瀏覽器中開啟」動作包含多張圖片';
            } else {
              const a=Array.isArray(args)?args[0]:null;
              const textUrl=typeof a==='string'?a:(typeof a?.url==='string'?a.url:'');
              if(textUrl)unknown='開啟網址不是 Discord 原始附件，已阻止跳轉';
            }
            // Do NOT invoke original / open a browser. Some bridge callers
            // await the result; return a resolved promise for compatibility.
            return Promise.resolve(true);
          });
          if(typeof unpatch==='function'){
            unpatches.push(unpatch);
            if(!state.browserHookNames.includes(label))state.browserHookNames.push(label);
          }
        }catch(e){reportError(e);}
      }
      if(unpatches.length===0){
        finish('','無法攔截 Discord 的網址開啟方法；未觸發瀏覽器動作');
        return;
      }
      try{
        const result=nativeBrowser.fn.call(nativeBrowser.receiver);
        if(result&&typeof result.catch==='function')result.catch(e=>{
          reportError(e);finish('','原生「在瀏覽器中開啟」動作執行失敗');
        });
      }catch(e){reportError(e);finish('','原生「在瀏覽器中開啟」動作拋出錯誤');return;}
      timer=setTimeout(()=>finish('',unknown||'瀏覽器動作沒有提供 Discord 附件網址'),2200);
    });
  };
  // A single tap is the only user operation. We never invoke Discord's native
  // Save action: it may write to the gallery or show additional UI.
  // Only read the current viewer URL or silently intercept the existing browser
  // action when an opener can be patched. If no safe source is available, fail.
  const resolveCurrentImage = async (context, nativeBrowser) => {
    const exact = mediaRecords(context,5);
    if (exact.length > 1) throw Error('無法確定目前圖片（找到多個來源）');
    if (exact.length === 1) { state.lastSourcePath='目前圖片選單';return exact[0].url; }
    const direct = currentURL(context);
    if (direct) { state.lastSourcePath='圖片檢視器';return direct; }
    const fromBrowser = await captureFromBrowserAction(nativeBrowser);
    if (fromBrowser) return fromBrowser;
    throw Error('無法取得目前圖片的原始檔案');
  };
  // Exactly one progress toast and one result toast per tap. The pipeline is
  // internal: resolve -> download -> validate -> login -> upload -> confirm.
  const oneTapSave = async (context, nativeBrowser) => {
    if (busy) return; // no duplicate request or extra popup
    busy = true;
    state.clicks++;
    state.error='';
    toast('正在保存…');
    try {
      const url = await resolveCurrentImage(context,nativeBrowser);
      await downloadAndUpload(url);
      state.uploads++;
      toast('已保存到 Card');
    } catch (e) {
      reportError(e);
      toast('保存失敗：' + state.error);
    } finally { busy=false; }
  };
  // Inspect the *current full-screen viewer* instead of assuming that a popup
  // contains attachment metadata. A renderer may receive a proxy image URI in
  // source.uri or an attachment.url in its media props.
  const mediaRecord = candidate => {
    if (typeof candidate !== 'string' || candidate.length > 3000) return null;
    let u; try { u = new URL(candidate); } catch (_) { return null; }
    if (u.protocol !== 'https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(u.hostname)) return null;
    if (!/^\/(?:attachments|ephemeral-attachments)\/[^?#]+\.(png|jpe?g|webp|gif|avif)$/i.test(u.pathname)) return null;
    const extension = u.pathname.split('.').pop().toLowerCase();
    const png = extension === 'png';
    if (u.hostname === 'media.discordapp.net') {
      u.hostname = 'cdn.discordapp.com';
      for (const k of Array.from(u.searchParams.keys())) {
        if (!['ex','is','hm'].includes(k)) u.searchParams.delete(k);
      }
    }
    return {url:u.href, extension, png};
  };
  // Bounded inspection of renderMedia() arguments/results. Only attachment
  // sources are considered; no message text or authentication data is saved.
  const mediaRecords = (root, maxDepth = 8) => {
    const records = new Map(), seen = new Set(); let count = 0;
    const allowed = /^(props|children|url|uri|src|source|sourceUri|sourceURL|mediaSource|imageSource|imageURI|mediaURI|contentUri|originalUrl|originalURL|originalUri|originalSource|original|asset|attachment|attachments|image|images|media|mediaItem|mediaData|items|item|data|message|selected|current|selectedItem|currentItem|selectedMedia|preview|file|fileURL|fileUrl|cdnUrl|proxy_url|proxyURL|proxyUrl|mediaUrl|mediaURL|fullUrl|fullURL|renderData|renderItem|content|imageUrl|imageURL|sourceUrl)$/i;
    const visit = (value, depth) => {
      if (count++ > 320 || depth > maxDepth || !value) return;
      if (typeof value === 'string') {
        const rec = mediaRecord(value); if (rec) records.set(rec.url,rec);
        return;
      }
      if (typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.slice(0,15).forEach(v=>visit(v,depth+1));
        return;
      }
      let index = 0;
      for (const [key,val] of Object.entries(value)) {
        if (++index > 65) break;
        if (allowed.test(key)) visit(val,depth+1);
      }
    };
    visit(root,0);
    return [...records.values()];
  };
  const updateViewerSource = (args, from) => {
    const found = mediaRecords(args);
    if (!found.length) return;
    state.renderMediaURLs += found.length;
    const urls = new Set(state.viewerSources);
    found.forEach(x=>urls.add(x.url));
    state.viewerSources = [...urls].slice(0,12);
    state.renderMediaAmbiguous = state.viewerSources.length > 1;
    const single = state.viewerSources.length === 1 ? mediaRecord(state.viewerSources[0]) : null;
    state.renderMediaURL = single ? single.url : '';
    state.mediaType = single ? single.extension.toUpperCase() : (state.renderMediaAmbiguous ? '多張圖片，來源不唯一' : '');
    state.sourceReason = from + '：' + (state.renderMediaAmbiguous ? '多張來源' : (single ? single.extension : '找不到來源'));
  };
  const installRenderMediaHooks = () => {
    const candidates = [];
    const add = (obj,desc) => {
      if (!obj || typeof obj.renderMedia !== 'function' || candidates.some(x=>x.obj===obj)) return;
      candidates.push({obj,desc});
    };
    try {add(v.metro?.findByProps?.('renderMedia'),'renderMedia export');}catch(_){}
    try {
      const named = v.metro?.findByProps?.('MediaViewerItemPresenter');
      const presenter = named?.MediaViewerItemPresenter;
      add(presenter?.prototype,'MediaViewerItemPresenter.prototype');
      add(presenter,'MediaViewerItemPresenter');
    }catch(_){}
    try {
      const named = v.metro?.findByName?.('MediaViewerItemPresenter');
      add(named?.prototype,'named presenter prototype');
    }catch(_){}
    for (const {obj,desc} of candidates) {
      const off = v.patcher?.before?.('renderMedia',obj,args=>{
        state.renderMediaCalls++;
        updateViewerSource(args,'renderMedia 參數');
      });
      if (typeof off === 'function') {cleanups.push(off);state.renderMediaHooks.push(desc);}
      // In some builds the resolved source appears only in the returned
      // React element, not in the render callback arguments.
      try {
        const after=v.patcher?.after?.('renderMedia',obj,(args,result)=>{
          updateViewerSource(result,'renderMedia 渲染結果');
        });
        if (typeof after==='function') {cleanups.push(after);state.renderMediaHooks.push(desc+' output');}
      }catch(e){reportError(e);}
    }
  };
  const allCandidateURLs = (root, limitDepth = 5) => {
    const found = new Set(), seen = new Set();
    const visit = (obj, depth) => {
      if (depth > limitDepth || !obj || found.size > 12) return;
      if (typeof obj === 'string') { const url = fileURL(obj); if (url) found.add(url); return; }
      if (typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      if (Array.isArray(obj)) { obj.slice(0, 12).forEach(x => visit(x, depth + 1)); return; }
      for (const [key, value] of Object.entries(obj).slice(0, 40)) {
        if (/^(url|originalUrl|originalURL|uri|source|src|image|imageUrl|media|attachment|attachments|selectedMedia|item|asset|data|props|message|viewer|images|currentItem|selectedItem|thumbnail|original|sourceURL|sourceUri|sourceURI|originalUri|mediaUrl|mediaURL|cdnUrl|fullUrl|fullURL|originalSource|fileUrl|fileURL)$/i.test(key)) visit(value, depth + 1);
      }
    };
    visit(root, 0);
    return [...found];
  };
  const currentURL = sheet => {
    // Prefer the individual menu's attached original URL when available.
    const explicit = mediaRecords(sheet,6);
    if (explicit.length > 1) {state.sourceReason='選單包含多個附件';return '';}
    if (explicit.length === 1) {
      state.mediaType=explicit[0].extension.toUpperCase();
      state.sourceReason='選單附件';
      return explicit[0].url;
    }
    // openMediaModal often has only navigation flags; its payload, when
    // available, is more specific than a broad message-attachment scan.
    if (state.contextUrl && Date.now() - state.contextAt < MAX_CONTEXT_AGE_MS) return state.contextUrl;
    // renderMedia belongs to the full-screen viewer. Never select one of
    // several distinct attachments (carousel/batch) by guesswork.
    if (!state.renderMediaAmbiguous && state.renderMediaURL && Date.now() - state.viewerTrackingAt < 90000) return state.renderMediaURL;
    return '';
  };
  // SillyTavern-compatible PNG character card reader.
  // ST primarily uses tEXt chunks containing Base64(UTF-8(JSON)); prefers
  // ccv3 (Character Card V3) over chara (V2 / legacy V1). Never alter the PNG.
  const readSillyTavernCard = bytes => {
    const signature = [137,80,78,71,13,10,26,10];
    if (bytes.length < 33 || signature.some((x,i)=>bytes[i]!==x)) throw Error('不是有效的 PNG 原圖');
    const read32 = i => bytes[i] * 0x1000000 + bytes[i+1]*65536 + bytes[i+2]*256 + bytes[i+3];
    const ascii = (a,b) => {
      let s='';
      for(let p=a;p<b;p+=8192) s+=String.fromCharCode(...bytes.subarray(p,Math.min(p+8192,b)));
      return s;
    };
    const decodeUtf8 = buf => {
      if (typeof TextDecoder === 'function') {
        try { return new TextDecoder('utf-8',{fatal:true}).decode(buf); } catch(e) { throw Error('角色卡 JSON 不是有效 UTF-8'); }
      }
      // Hermes builds may not expose TextDecoder. Validate Unicode strictly.
      let output='';
      for(let i=0;i<buf.length;){
        const b=buf[i++];let cp,extra,min;
        if(b<128){cp=b;extra=0;min=0;}
        else if(b>=194&&b<=223){cp=b&31;extra=1;min=128;}
        else if(b>=224&&b<=239){cp=b&15;extra=2;min=2048;}
        else if(b>=240&&b<=244){cp=b&7;extra=3;min=65536;}
        else throw Error('角色卡 JSON UTF-8 格式錯誤');
        for(let j=0;j<extra;j++){
          if(i>=buf.length||buf[i]<128||buf[i]>191)throw Error('角色卡 JSON UTF-8 格式錯誤');
          cp=(cp<<6)|(buf[i++]&63);
        }
        if(cp<min||cp>1114111||(cp>=55296&&cp<=57343))throw Error('角色卡 JSON UTF-8 格式錯誤');
        if(cp<=65535)output+=String.fromCharCode(cp);
        else {cp-=65536;output+=String.fromCharCode(55296+(cp>>10),56320+(cp&1023));}
      }
      return output;
    };
    const base64Bytes = input => {
      const str=input.replace(/\s+/g,'');
      if(str.length>9*1024*1024||!str||str.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(str))throw Error('角色卡 Base64 格式錯誤');
      const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const out=new Uint8Array(Math.ceil(str.length*3/4));let at=0,bits=0,bucket=0;
      for(let i=0;i<str.length;i++){
        const c=str[i];if(c==='=')break;
        const n=alphabet.indexOf(c);if(n<0)throw Error('角色卡 Base64 格式錯誤');
        bucket=(bucket<<6)|n;bits+=6;
        if(bits>=8){bits-=8;out[at++]=(bucket>>>bits)&255;}
      }
      if(at>8*1024*1024)throw Error('角色卡 JSON 過大');
      return out.subarray(0,at);
    };
    const contents={ccv3:[],chara:[]};
    let pos=8,ihdr=false,iend=false,unsupportedCompression=false;
    for(let chunks=0;pos+12<=bytes.length&&chunks<20000;chunks++){
      const size=read32(pos);
      if(size>bytes.length-pos-12)throw Error('PNG 區塊長度無效，可能已損壞');
      const typ=ascii(pos+4,pos+8), start=pos+8, stop=start+size;
      if(typ==='IHDR')ihdr=true;
      if(['tEXt','iTXt','zTXt'].includes(typ)&&size<=9*1024*1024){
        let nul=start;while(nul<stop&&nul-start<=79&&bytes[nul]!==0)nul++;
        if(nul<stop&&nul-start<=79){
          const key=ascii(start,nul);
          if(key==='ccv3'||key==='chara'){
            if(typ==='tEXt')contents[key].push(ascii(nul+1,stop));
            else if(typ==='zTXt')unsupportedCompression=true;
            else if(nul+2<stop){
              const compressed=bytes[nul+1];
              let p=nul+3; // compression flag, compression method
              for(let field=0;field<2&&p<stop;field++){
                while(p<stop&&bytes[p]!==0)p++;
                p++; // language tag and translated keyword
              }
              if(compressed===0&&p<=stop)contents[key].push(ascii(p,stop));
              else unsupportedCompression=true;
            }
          }
        }
      }
      pos=stop+4; // skip CRC without changing a single byte
      if(typ==='IEND'){iend=true;break;}
    }
    if(!ihdr||!iend)throw Error('PNG 區塊結構不完整');
    let invalid='';
    for(const key of ['ccv3','chara']){
      for(const payload of contents[key]){
        try {
          const decoded=decodeUtf8(base64Bytes(payload));
          const card=JSON.parse(decoded);
          if(!card||typeof card!=='object'||Array.isArray(card))throw Error('角色卡 JSON 不是物件');
          const wrapped=card.data&&typeof card.data==='object'&&!Array.isArray(card.data);
          const data=wrapped?card.data:card;
          if(typeof data.name!=='string'||!data.name.trim())throw Error('角色卡缺少角色名稱');
          const spec=typeof card.spec==='string'?card.spec:'';
          if(wrapped && spec && !/^chara_card_v[23]$/.test(spec))throw Error('角色卡 spec 不支援');
          if(!wrapped&&!['description','personality','scenario','first_mes','mes_example'].some(k=>Object.prototype.hasOwnProperty.call(data,k)))throw Error('缺少角色卡內容欄位');
          return {kind:key,version:key==='ccv3'?'V3':(spec==='chara_card_v2'?'V2':'V1/V2'),name:data.name.trim().slice(0,80)};
        } catch(e) { invalid=String(e&&e.message||e); }
      }
    }
    if(invalid)throw Error('包含角色卡欄位，但解析失敗：'+invalid.slice(0,110));
    if(unsupportedCompression)throw Error('角色卡使用壓縮文字區塊，當前解析器暫不支援');
    throw Error('未找到 SillyTavern 角色卡資料（ccv3/chara）；請使用未經轉碼的原始 PNG');
  };
  const serverBase = () => {
    let u;
    try { u = new URL(config.server.trim()); } catch (_) { throw Error('CardVault 網站地址無效'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw Error('請輸入網站根地址，不含路徑');
    if (u.protocol === 'http:' && !config.allowHttp) throw Error('請先在插件設定中允許 HTTP 明文連線');
    return u.origin;
  };
  const downloadAndUpload = async url => {
    if (!url) throw Error('無法取得目前圖片的原始檔案');
    const src = fileURL(url);
    if (!src) throw Error('無法取得 Discord 原始附件');
    if (!config.username || !config.password) throw Error('CardVault 帳號尚未設定');
    const base = serverBase();
    const download = await fetch(src);
    if (!download.ok) throw Error('下載圖片失敗（HTTP '+download.status+'）');
    const declared = Number(download.headers?.get?.('content-length') || 0);
    if (declared > MAX_BYTES) throw Error('圖片超過 30 MB');
    const raw = await download.arrayBuffer();
    if (raw.byteLength > MAX_BYTES) throw Error('圖片超過 30 MB');
    const bytes = new Uint8Array(raw);
    const mime = mimeOf(bytes);
    if (mime !== 'image/png') throw Error('這張圖片不是 PNG 角色卡');
    const cardInfo = readSillyTavernCard(bytes);
    state.last = '已解析 '+cardInfo.version+' 角色卡：'+cardInfo.name;
    const login = await fetch(base + '/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:config.username,password:config.password})});
    if (!login.ok) throw Error('登入失敗（HTTP '+login.status+'）');
    const json = await login.json();
    const token = json?.token || json?.data?.token;
    if (typeof token !== 'string' || !token) throw Error('登入沒有取得憑證');
    let filename = 'discord-card.png';
    try {filename = (decodeURIComponent(new URL(src).pathname.split('/').pop()||filename)).replace(/[\r\n\\]/g,'_').slice(0,180);}catch(_){}
    const response = await fetch(base+'/api/cards/import',{method:'POST',headers:{'Content-Type':'image/png','Authorization':'Bearer '+token,'X-File-Name':filename},body:raw});
    if (!response.ok) throw Error('CardVault 拒絕上傳（HTTP '+response.status+'）：'+(await response.text()).slice(0,100));
    const reply = await response.text();
    let parsed=null;
    try {parsed=JSON.parse(reply);}catch(_){}
    if(parsed && typeof parsed==='object' && (parsed.success===false || parsed.ok===false || parsed.error)){
      throw Error('CardVault 回報失敗：'+text(parsed.message||parsed.error||reply));
    }
    state.lastUpload=filename;
  };
  const labelsOf = option => typeof option?.label === 'string' ? option.label : (typeof option?.text === 'string' ? option.text : '');
  const isSave = label => /^(保存|Save|Save Image|Save Media|Download|儲存|储存)$/i.test(label);
  const isShare = label => /^(分享|Share|转发|轉發|Forward)$/i.test(label);
  const isBrowser = label => /^(在浏览器中打开|在瀏覽器中開啟|在瀏覽器中打開|Open in Browser|Open in browser|Open in External Browser)$/i.test(label);
  const isImageSheet = sheet => {
    if (!sheet || !Array.isArray(sheet.options)) return false;
    const labels = sheet.options.map(labelsOf);
    return labels.some(isSave) && labels.some(isShare) && labels.some(isBrowser);
  };
  const inspectSheet = args => {
    state.sheets++;
    if (!Array.isArray(args)) return;
    const sheet = args[0];
    if (!isImageSheet(sheet)) return;
    state.menuMatches++;
    if (sheet.options.some(o => labelsOf(o) === '保存到 Card')) return;
    const pos = sheet.options.findIndex(o => isSave(labelsOf(o)));
    if (pos < 0) return;
    // Always display the action in the recognized image menu. Determine URL at press time.
    const original = sheet.options[pos];
    const save = originalAction(original);
    const browserIndex=sheet.options.findIndex(o=>isBrowser(labelsOf(o)));
    const open=browserIndex>=0?originalAction(sheet.options[browserIndex]):null;
    const item = { label:'保存到 Card', onPress: () => oneTapSave(sheet,open) };
    if (original && original.icon != null) item.icon = original.icon;
    const options = sheet.options.slice();
    options.splice(pos + 1, 0, item);
    sheet.options = options;
    state.injections++;
    state.last = '已插入圖片選單';
  };
  // Additional strategy: some Discord 351.x overflow menus are rendered as
  // React/JSX popup items, NOT by showSimpleActionSheet. Inspect freshly built
  // element trees and only touch a sibling array resembling the image menu.
  // This is reversible via patcher unpatch functions; nothing uploads on render.
  const menuText = (item, depth = 0) => {
    if (depth > 6 || item == null) return '';
    if (typeof item === 'string') return item.trim();
    if (typeof item !== 'object') return '';
    for (const key of ['label','title','text','name']) {
      if (typeof item[key] === 'string' && item[key].length < 80) return item[key].trim();
    }
    const p = item.props;
    if (p && typeof p === 'object') {
      for (const key of ['label','title','text','name']) {
        if (typeof p[key] === 'string' && p[key].length < 80) return p[key].trim();
      }
      if (typeof p.children === 'string') return p.children.trim();
      if (p.children && !Array.isArray(p.children)) return menuText(p.children, depth + 1);
      if (Array.isArray(p.children) && p.children.length <= 8) {
        const labels=p.children.map(c=>menuText(c,depth+1)).filter(Boolean);
        const matches=labels.filter(x=>isSave(x)||isShare(x)||isBrowser(x));
        if(matches.length===1)return matches[0];
      }
    }
    return '';
  };
  const hasCallback = obj => obj && typeof obj === 'object' &&
    ['onPress','onClick','onSelect','action','callback','onActivate'].some(k => typeof obj[k] === 'function');
  const makeAction = (orig, handler, depth = 0) => {
    if (!orig || typeof orig !== 'object' || depth > 5) return null;
    const isElement = !!orig.props && typeof orig.props === 'object' && orig.type != null;
    const props = isElement ? orig.props : orig;
    const changed = {...props};
    let changedLabel = false, changedHandler = false;
    for (const key of ['label','title','text','name']) {
      if (typeof props[key] === 'string' && isSave(props[key])) { changed[key] = '保存到 Card'; changedLabel = true; }
    }
    for (const key of ['onPress','onClick','onSelect','action','callback','onActivate']) {
      if (typeof props[key] === 'function') { changed[key] = handler; changedHandler = true; }
    }
    if (!changedHandler && isElement && !hasCallback(props)) {
      // Some menu items' outer component only stores the label; the callback
      // belongs to its inner Pressable. Replace only a single-child chain.
      if (props.children && !Array.isArray(props.children)) {
        const child = makeAction(props.children, handler, depth+1);
        if (child) { changed.children = child; changedHandler = true; }
      } else if (Array.isArray(props.children) && props.children.length <= 8) {
        for (let i=0;i<props.children.length;i++) {
          const child = makeAction(props.children[i], handler, depth+1);
          if (child) { changed.children = props.children.slice(); changed.children[i]=child; changedHandler = true; break; }
        }
      }
    }
    if (!changedLabel && typeof props.children === 'string' && isSave(props.children)) {
      changed.children = '保存到 Card'; changedLabel = true;
    }
    if (!changedLabel && props.children && !Array.isArray(props.children)) {
      const child = cloneLabel(props.children, depth+1);
      if (child) { changed.children = child; changedLabel = true; }
    }
    if (!changedLabel && Array.isArray(props.children) && props.children.length <= 8) {
      for(let i=0;i<props.children.length;i++) {
        const child=cloneLabel(props.children[i],depth+1);
        if(child){changed.children=props.children.slice();changed.children[i]=child;changedLabel=true;break;}
      }
    }
    if (!changedLabel || !changedHandler) return null;
    if ('id' in changed) changed.id = 'save-to-card-image';
    if ('key' in changed) changed.key = 'save-to-card-image';
    if ('disabled' in changed) changed.disabled = false;
    if ('isDisabled' in changed) changed.isDisabled = false;
    if (!isElement) return changed;
    const React = v.metro?.common?.React;
    if (typeof React?.cloneElement === 'function') {
      try { return React.cloneElement(orig, {...changed,key:'save-to-card-image'}); } catch (_) {}
    }
    return {...orig,props:changed,key:'save-to-card-image'};
  };
  const cloneLabel = (obj, depth = 0) => {
    if (depth > 6 || obj == null) return null;
    if (typeof obj === 'string') return isSave(obj) ? '保存到 Card' : null;
    if (typeof obj !== 'object') return null;
    const props = obj.props;
    if (!props || typeof props !== 'object') return null;
    const p = {...props};let change = false;
    for (const k of ['label','title','text','name']) {
      if (typeof p[k] === 'string' && isSave(p[k])) {p[k]='保存到 Card';change=true;}
    }
    if (typeof p.children === 'string' && isSave(p.children)) {p.children='保存到 Card';change=true;}
    if (!change && p.children && !Array.isArray(p.children)) {
      const c=cloneLabel(p.children,depth+1);if(c){p.children=c;change=true;}
    }
    if (!change && Array.isArray(p.children) && p.children.length<=8) {
      for(let i=0;i<p.children.length;i++){
        const c=cloneLabel(p.children[i],depth+1);
        if(c){p.children=p.children.slice();p.children[i]=c;change=true;break;}
      }
    }
    if (!change) return null;
    const React=v.metro?.common?.React;
    if (typeof React?.cloneElement==='function') {
      try {return React.cloneElement(obj,p);} catch(_){}
    }
    return {...obj,props:p};
  };
  const spliceImageMenu = (arr, context) => {
    if (!Array.isArray(arr) || arr.length < 3 || arr.length > 18) return null;
    const labels=arr.map(menuText);
    if (!labels.some(isSave) || !labels.some(isShare) || !labels.some(isBrowser)) return null;
    if (labels.includes('保存到 Card')) return null;
    state.jsxMenuMatches++;
    const pos=labels.findIndex(isSave), original=arr[pos];
    // First render the action even when image URL isn't available. On click,
    // show the error rather than silently uploading another image.
    const save=originalAction(original);
    const browserIndex=labels.findIndex(isBrowser);
    const open=browserIndex>=0?originalAction(arr[browserIndex]):null;
    const action=makeAction(original,()=>oneTapSave(context,open));
    if (!action) { state.last='找到圖片選單，但無法安全複製保存項目';return null; }
    const result=arr.slice();result.splice(pos+1,0,action);
    state.injections++;
    state.last='JSX 圖片選單已插入保存到 Card';
    return result;
  };
  const menuFields = ['options','items','actions','menuItems','menuOptions','actionItems','children','rows'];
  const transformMenu = (props, depth = 0) => {
    if (!props || typeof props!=='object' || depth > 2) return null;
    let next=null;
    for(const key of menuFields) {
      if (!Array.isArray(props[key])) continue;
      const patched=spliceImageMenu(props[key],props);
      if(patched){next=next||{...props};next[key]=patched;break;}
    }
    if(next)return next;
    if(depth<2){for(const key of ['menu','data','menuData','content','config']){
      if(!props[key] || Array.isArray(props[key]) || typeof props[key]!=='object') continue;
      const nested=transformMenu(props[key],depth+1);
      if(nested){return {...props,[key]:nested};}
    }}
    return null;
  };
  const inspectElement = element => {
    state.jsxCalls++;
    if(!element || typeof element!=='object' || !element.props)return element;
    // Source capture from freshly created image elements in the *open* media
    // viewer. Only inspect direct image source props (never message text).
    // Multiple distinct CDN attachments are treated as ambiguous, not guessed.
    if (state.viewerTrackingAt && Date.now() - state.viewerTrackingAt < 90000) {
      const props=element.props;
      const sources = [props.source,props.src,props.imageSource,props.mediaSource,props.imageURI,props.imageUrl];
      for (const candidate of sources) {
        const urls = mediaRecords(candidate,3);
        if (urls.length) {
          state.jsxSourcesSeen += urls.length;
          updateViewerSource(candidate,'React/JSX 圖片來源');
        }
      }
    }
    const changed=transformMenu(element.props);
    if(!changed)return element;
    const React=v.metro?.common?.React;
    if(typeof React?.cloneElement==='function'){
      try{return React.cloneElement(element,changed);}catch(_){}
    }
    return {...element,props:changed};
  };
  const patchAfter = (method, mod, cb, label) => {
    if(!mod || typeof mod[method]!=='function' || typeof v.patcher?.after!=='function')return false;
    try {const unpatch=v.patcher.after(method,mod,cb);
      if(typeof unpatch!=='function')return false;
      cleanups.push(unpatch);state.jsxHooks.push(label);return true;
    }catch(e){reportError(e);return false;}
  };
  const installJSXHooks = () => {
    // React.createElement and automatic JSX runtime are distinct factory paths.
    // Patch both to cover different Discord bundles without relying on guessed
    // image-menu component names.
    const React=v.metro?.common?.React;
    patchAfter('createElement',React,(args,result)=>inspectElement(result),'React.createElement');
    const names=[['jsx','jsxs'],['jsx','jsxs','Fragment'],['jsxDEV']];
    const modules=[];
    for(const keys of names){
      try {const m=v.metro?.findByProps?.(...keys);
        if(m && !modules.includes(m))modules.push(m);
      }catch(_){}
    }
    for(const m of modules){
      for(const method of ['jsx','jsxs','jsxDEV']){
        if(typeof m[method]==='function')patchAfter(method,m,(args,result)=>inspectElement(result),'JSX.'+method);
      }
    }
    // Popup opening gives diagnostics even if props aren't rendered through
    // the factories we can intercept. NEVER suppress the original popup.
    try {const m=v.metro?.findByProps?.('openLazy');
      if(m && typeof m.openLazy==='function') {
        const off=v.patcher.before('openLazy',m,args=>{
          state.lazyCalls++;
          for(const x of args||[]){if(x && typeof x==='object'){
            const changed=transformMenu(x);
            if(changed) {try{Object.assign(x,changed);}catch(e){reportError(e);}}
          }}
        });
        if(typeof off==='function'){cleanups.push(off);state.jsxHooks.push('ActionSheet.openLazy');}
      }
    }catch(e){reportError(e);}
  };
  const patchMethod = (method, matcher, callback) => {
    try {
      const m = v.metro?.findByProps?.(method);
      if (!m || typeof m[method] !== 'function' || (matcher && !matcher(m))) return false;
      const unpatch = v.patcher?.before?.(method, m, callback);
      if (typeof unpatch !== 'function') return false;
      cleanups.push(unpatch);
      return true;
    } catch(e) { reportError(e); return false; }
  };
  const rememberViewerContext = args => {
    state.viewerTrackingAt=Date.now();
    state.viewerSources = [];state.renderMediaURL='';state.renderMediaAmbiguous=false;
    state.mediaType='';state.sourceReason='查看器已開啟，等待媒體來源';
    if (!args || !Array.isArray(args)) return;
    const records = mediaRecords(args,8);
    state.contextUrl = records.length===1 ? records[0].url : '';
    state.contextAt = state.contextUrl ? Date.now() : 0;
    if (records.length===1) {state.mediaType=records[0].extension.toUpperCase();state.sourceReason='openMediaModal 參數';}
    else if (records.length>1) {state.sourceReason='openMediaModal 多張候選附件';}
  };
  const plugin = {
    onLoad() {
      if (state.started) return;
      state.started = true;
      state.last = '插件已啟動';
      state.sheetHook = patchMethod('showSimpleActionSheet', null, inspectSheet);
      installJSXHooks();
      installRenderMediaHooks();
      // Do not install native Save capture: a one-tap Card import must not save to gallery.
      const mediaMethodNames = ['openMediaModal', 'openMediaViewer', 'openImageViewer', 'openMediaCarousel', 'openImageModal'];
      for (const method of mediaMethodNames) {
        if (patchMethod(method, null, rememberViewerContext)) state.viewerHooks.push(method);
      }
      state.last='插件就緒，等待點擊保存到 Card';
    },
    onUnload() {
      while (cleanups.length) { try { cleanups.pop()(); } catch (e) { logger(e); } }
      state.started = false;
      state.contextUrl = '';state.renderMediaURL='';state.viewerSources=[];state.viewerTrackingAt=0;waitingSave=null;
    },
    settings: function SaveToCardSettings() {
      const React = v.metro?.common?.React, RN = v.metro?.common?.ReactNative;
      if (!React || !RN?.Text || !RN?.ScrollView || !RN?.TextInput || !RN?.Switch || !RN?.Pressable) return null;
      const h=React.createElement;
      const [form,setForm] = React.useState({...config});
      const [tick,refresh] = React.useState(0);
      const edit = (name,val) => { saveConfig(name,val); setForm(x => ({...x,[name]:val})); };
      const tx = (s,style={}) => h(RN.Text,{style:{fontSize:14,color:'#ebebf4',marginBottom:10,...style}},s);
      const fld = (name,title,secret=false) => h(RN.View,{key:name,style:{marginBottom:16}},
        tx(title), h(RN.TextInput,{value:form[name],onChangeText:value=>edit(name,value),secureTextEntry:secret,autoCapitalize:'none',autoCorrect:false,
          style:{color:'#ffffff',backgroundColor:'#454751',borderRadius:9,paddingHorizontal:12,paddingVertical:10,minHeight:45}}));
      const tog = (name,title,detail) => h(RN.View,{key:name,style:{flexDirection:'row',alignItems:'center',marginBottom:15}},
        h(RN.View,{style:{flex:1}},tx(title,{fontSize:16,marginBottom:2}),tx(detail,{color:'#b6baca',fontSize:12,marginBottom:0})),
        h(RN.Switch,{value:!!form[name],onValueChange:x=>edit(name,x)}));
      const info = (k,v) => tx(k + '：' + String(v),{fontSize:13,color:'#b6baca',marginBottom:5});
      return h(RN.ScrollView,{style:{flex:1},contentContainerStyle:{padding:18,paddingBottom:55}},
        tx('保存到 Card v1.7（一鍵保存版）',{fontSize:23,fontWeight:'bold'}),
        tx('點一次「保存到 Card」→ 顯示「正在保存…」→ 背後自動導入 → 成功後顯示「已保存到 Card」。',{color:'#aeb4c8'}),
        fld('server','CardVault 網址'),fld('username','CardVault 用戶名'),fld('password','CardVault 密碼',true),
        tog('allowHttp','允許 HTTP 明文連線','你的 CardVault 目前是 HTTP；帳密可能被網路截取'),
        tx('遵循 SillyTavern：優先 ccv3，回退 chara，解碼 Base64/UTF-8/JSON 驗證；只上傳原始 PNG，不轉碼。',{fontSize:12,color:'#b6baca'}),
        tx('執行狀態',{fontSize:18,fontWeight:'bold',marginTop:14}),
        info('已啟動',state.started?'是':'否'),info('圖片選單 Hook',state.sheetHook?'是':'否'),
        info('圖片檢視器 Hook',state.viewerHooks.join(', ')||'未找到'),
        info('renderMedia 鉤子',state.renderMediaHooks.join(', ')||'未找到'),
        info('renderMedia 呼叫',state.renderMediaCalls),
        info('瀏覽器來源捕捉嘗試',state.browserAttempts),
        info('瀏覽器來源捕捉成功',state.browserCaptures),
        info('瀏覽器動作攔截',state.browserHookNames.join(', ')||'未執行'),
        info('瀏覽器來源狀態',state.browserReason||'尚未測試'),
        info('最近圖片來源',state.lastSourcePath||'尚未找到'),
        info('Discord 原生保存 Hook',nativeDownload.hook?'是':'否'),
        info('原生保存捕獲',nativeDownload.captures),
        info('目前來源類型',state.mediaType||'未知'),
        info('來源辨識',state.sourceReason||'尚未檢查'),
        info('React/JSX 鉤子',state.jsxHooks.join(', ')||'未找到'),info('JSX 執行次數',state.jsxCalls),info('查看器圖片來源探測',state.jsxSourcesSeen),
        info('JSX 圖片選單命中',state.jsxMenuMatches),info('openLazy 呼叫',state.lazyCalls),
        info('ActionSheet 呼叫',state.sheets),info('圖片選單命中',state.menuMatches),
        info('插入次數',state.injections),info('按鈕點擊',state.clicks),info('成功上傳',state.uploads),
        info('目前圖片 URL',(state.contextUrl||state.renderMediaURL)?'已捕獲':'尚未捕獲'),
        info('最近狀態',state.last),info('最近錯誤',state.error||'無'),
        h(RN.Pressable,{style:{backgroundColor:'#5865f2',borderRadius:10,padding:14,marginTop:20},onPress:()=>refresh(x=>x+1)},
          tx('更新診斷',{fontSize:16,fontWeight:'bold',textAlign:'center',marginBottom:0})),
        tx('依照 SillyTavern PNG 角色卡格式驗證後，仍向既有 CardVault /api/cards/import 傳原始 PNG。圖片地址優先使用目前檢視器；必要時攔截選單既有開啟連結。絕不呼叫原生「保存」按鈕，不另存相冊、不要求使用者再次確認。原始附件仍需由 Discord 提供；實機尚待驗證。',{fontSize:12,color:'#b6baca',marginTop:18})
      );
    }
  };
  return plugin;
})()
