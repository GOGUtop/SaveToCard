(() => {
  // Vendetta loader embeds this entire file immediately after `return`.
  // IMPORTANT: Do not place a multiline comment/newline before the expression!
  'use strict';
  const api = vendetta;
  const state = {
    started: false, startedCount: 0, endedCount: 0,
    loadError: '', menuError: '', hookSimple: false, hookLazy: false,
    simpleCalls: 0, lazyCalls: 0, matchedMenus: 0, testPresses: 0,
    lastSheet: '尚未打開選單', lastEvent: '等待 onLoad()'
  };
  const cleanups = [];
  const testLabel = 'Card 測試（不會上傳）';
  const limit = (text) => String(text == null ? '' : text).replace(/[\r\n\t]/g, ' ').slice(0, 85);
  const toast = (text) => {
    try { api.ui.toasts.showToast(limit(text)); } catch (_) {}
  };
  const log = (text) => {
    try { api.logger?.log?.('[CardProbe] ' + limit(text)); } catch (_) {}
  };
  const stop = () => {
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      try { if (typeof cleanup === 'function') cleanup(); } catch (_) {}
    }
    state.started = false;
    state.endedCount++;
  };
  const installHook = (name, method, handler) => {
    const patcher = api.patcher;
    if (!patcher || typeof patcher.before !== 'function') return false;
    let module;
    try { module = api.metro.findByProps(method); } catch (e) { state.menuError = limit(e); return false; }
    if (!module || typeof module[method] !== 'function') return false;
    try {
      const unpatch = patcher.before(method, module, handler);
      if (typeof unpatch === 'function') cleanups.push(unpatch);
      return true;
    } catch (e) {
      state.menuError = limit(e);
      log(name + ' patch error: ' + state.menuError);
      return false;
    }
  };
  const normalizeLabel = (option) => {
    if (!option || typeof option !== 'object') return '';
    // We look only at the presence of common labels; never store their content.
    return typeof option.label === 'string' ? option.label : '';
  };
  const isPhotoSheet = (sheet) => {
    if (!sheet || !Array.isArray(sheet.options)) return false;
    const labels = sheet.options.map(normalizeLabel);
    const save = labels.some(v => /^(保存|Save|Save Image|Download)$/i.test(v));
    const share = labels.some(v => /^(分享|Share)$/i.test(v));
    const open = labels.some(v => /^(在瀏覽器中開啟|在浏览器中打开|Open in Browser|Open in browser)$/i.test(v));
    return save && share && open;
  };
  const inspectSimple = (args) => {
    state.simpleCalls++;
    if (!Array.isArray(args)) return;
    const sheet = args[0];
    if (!sheet || typeof sheet !== 'object') return;
    state.lastSheet = 'simple-sheet（已匿名化）';
    if (!isPhotoSheet(sheet)) return;
    state.matchedMenus++;
    state.lastEvent = '命中圖片選單（simple-sheet）';
    if (sheet.options.some(opt => normalizeLabel(opt) === testLabel)) return;
    const at = sheet.options.findIndex(opt => /^(保存|Save|Save Image|Download)$/i.test(normalizeLabel(opt)));
    if (at < 0) return;
    // Mutating only a verified, recognizable photo menu. A test-only action; no upload.
    const newOption = { label: testLabel, onPress: () => {
      state.testPresses++;
      state.lastEvent = '已點擊 Card 測試按鈕';
      toast('Card 測試成功：沒有上傳任何圖片');
    } };
    try { sheet.options = sheet.options.slice(); sheet.options.splice(at + 1, 0, newOption); }
    catch (e) { state.menuError = limit(e); }
  };
  const inspectLazy = (args) => {
    state.lazyCalls++;
    const arg0 = Array.isArray(args) ? args[0] : undefined;
    // Never access or persist content of messages, media, or account data.
    state.lastSheet = 'lazy-sheet（入口已觸發）';
    const name = typeof arg0 === 'function' ? arg0.name : '';
    state.lastEvent = 'openLazy 呼叫 ' + (name && /^[\w$]{1,45}$/.test(name) ? '(' + name + ')' : '（元件名不可用）');
  };
  const plugin = {
    onLoad() {
      if (state.started) return;
      state.started = true;
      state.startedCount++;
      state.lastEvent = 'onLoad 已執行';
      try {
        state.hookSimple = installHook('simple', 'showSimpleActionSheet', inspectSimple);
        state.hookLazy = installHook('lazy', 'openLazy', inspectLazy);
      } catch (e) {
        state.loadError = limit(e);
        log('onLoad: ' + state.loadError);
      }
      toast('Card v0.4 診斷插件已啟動');
    },
    onUnload() { stop(); },
    settings: function CardProbeSettings() {
      const React = api.metro.common.React;
      const RN = api.metro.common.ReactNative;
      if (!React || !RN || !RN.ScrollView || !RN.Text || !RN.Pressable) return null;
      const h = React.createElement;
      const useState = React.useState;
      const refreshState = useState(0);
      const setTick = refreshState[1];
      const textStyle = { color: '#e5e7eb', fontSize: 15, marginBottom: 10 };
      const tinyStyle = { color: '#bac4d6', fontSize: 13, marginBottom: 7 };
      const line = (k, value) => h(RN.Text, { key:k, style:tinyStyle }, k + '：' + String(value));
      return h(RN.ScrollView, { style:{flex:1}, contentContainerStyle:{padding:18, paddingBottom:48} },
        h(RN.Text, { style:{color:'#ffffff',fontSize:22,fontWeight:'bold',marginBottom:10} }, 'Card v0.4 最小診斷'),
        h(RN.Text, { style:textStyle }, '設定頁能顯示，代表 Vendetta 格式正確。此版本不會讀取圖片、登入網站或上傳。'),
        line('已執行 onLoad', state.started ? '是' : '否'),
        line('啟動次數',state.startedCount),
        line('已掛載 simple-sheet',state.hookSimple ? '是':'否'),
        line('已掛載 openLazy',state.hookLazy ? '是':'否'),
        line('simple-sheet 呼叫',state.simpleCalls),
        line('openLazy 呼叫',state.lazyCalls),
        line('已識別圖片菜單',state.matchedMenus),
        line('Card 測試點擊',state.testPresses),
        line('最近類型',state.lastSheet),
        line('最近事件',state.lastEvent),
        line('載入錯誤',state.loadError||'無'),
        line('選單錯誤',state.menuError||'無'),
        h(RN.Pressable, { onPress: () => setTick(v => v + 1), style:{backgroundColor:'#5865f2',padding:14,borderRadius:10,marginTop:18} },
          h(RN.Text,{style:{color:'#fff',fontSize:16,textAlign:'center',fontWeight:'bold'}},'刷新診斷數值')),
        h(RN.Text,{style:{color:'#a3a3a3',fontSize:13,marginTop:18}},'在 Discord 打開圖片 ⋮ 菜單後，返回此頁點「刷新」。若沒有 Card 測試按鈕，請回傳診斷數值。')
      );
    }
  };
  return plugin;
})()