/**
 * Hermes-compatible card elements:
 * 1. Top Card 2.0 Header (blue streaming / green completed / red error)
 * 2. Weather & Air quality metrics provider
 * 3. Literary quotes / Hitokoto provider
 * 4. Compact metrics formatting
 */

export interface HermesHeaderConfig {
  status: 'streaming' | 'completed' | 'error' | 'stopped';
  currentTool?: string;
}

export function buildHermesHeader(params: HermesHeaderConfig) {
  const { status, currentTool } = params;
  const states = {
    streaming: { template: 'blue', zh: '💭 处理中...', en: '💭 Processing...' },
    completed: { template: 'green', zh: '✅ 已完成', en: '✅ Completed' },
    error: { template: 'red', zh: '出错', en: 'Error' },
    stopped: { template: 'red', zh: '已停止', en: 'Stopped' },
  };
  const cfg = states[status] || states.completed;
  let zh = cfg.zh;
  let en = cfg.en;
  if (status === 'streaming' && currentTool) {
    const toolText = currentTool.length > 25 ? `${currentTool.slice(0, 22)}...` : currentTool;
    zh = `${zh} ⚡ ${toolText}`;
    en = `${en} ⚡ ${toolText}`;
  }
  return {
    title: {
      tag: 'plain_text' as const,
      content: en,
      i18n_content: {
        zh_cn: zh,
        en_us: en,
      },
    },
    template: cfg.template,
  };
}

export function compactHermesNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) {
    const m = value / 1e6;
    return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (abs >= 1e3) {
    const k = value / 1e3;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  return String(value);
}

export function formatElapsedHermes(ms: number): string {
  const s = (ms || 0) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function formatElapsedCn(ms: number): string {
  const s = (ms || 0) / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m} 分 ${rem} 秒`;
}

// ---------------------------------------------------------------------------
// Weather Cache
// ---------------------------------------------------------------------------
let _weatherCache = '';
let _weatherCacheTime = 0;

export function getHermesWeather(): string {
  const now = Date.now();
  if (_weatherCache && now - _weatherCacheTime < 300000) return _weatherCache;
  if (now - _weatherCacheTime > 60000) {
    _weatherCacheTime = now;
    Promise.all([
      fetch(
        'https://api.open-meteo.com/v1/forecast?latitude=30.42&longitude=120.30&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=Asia%2FShanghai',
      ).then((r) => r.json()),
      fetch(
        'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=30.42&longitude=120.30&current=european_aqi&timezone=Asia%2FShanghai',
      ).then((r) => r.json()),
    ])
      .then(([w, a]: [any, any]) => {
        const rh = w?.current?.relative_humidity_2m ?? 80;
        const maxT = w?.daily?.temperature_2m_max?.[0] ?? 26;
        const minT = w?.daily?.temperature_2m_min?.[0] ?? 19;
        const sunrise = (w?.daily?.sunrise?.[0] ?? '06:00').slice(-5);
        const sunset = (w?.daily?.sunset?.[0] ?? '18:00').slice(-5);
        const aqi = a?.current?.european_aqi ?? 50;
        const code = w?.current?.weather_code ?? 0;
        const icon = code === 0 ? '☀️' : code <= 3 ? '⛅' : code >= 51 ? '🌧️' : '☁️';
        _weatherCache = `${icon} 临平 ${maxT.toFixed(1)}/${minT.toFixed(1)}°C · 湿度 ${rh}% · 空气质量 ${aqi} · 日出 ${sunrise} 日落 ${sunset}`;
      })
      .catch(() => {});
  }
  return _weatherCache || '☀️ 临平 26.0/20.0°C · 湿度 88% · 空气质量 70 · 日出 06:03 日落 17:23';
}

// ---------------------------------------------------------------------------
// Hitokoto / Quotes Cache
// ---------------------------------------------------------------------------
const _fallbackHitokotos = [
  '黄沙百战穿金甲，不破楼兰终不还。 —— 从军行七首·其四',
  '大鹏一日同风起，扶摇直上九万里。 —— 上李邕',
  '长风破浪会有时，直挂云帆济沧海。 —— 行路难',
  '山重水复疑无路，柳暗花明又一村。 —— 游山西村',
  '星光不问赶路人，时光不负有心人。',
  '落霞与孤鹜齐飞，秋水共长天一色。 —— 滕王阁序',
  '博观而约取，厚积而薄发。 —— 稼说送张琥',
  '路漫漫其修远兮，吾将上下而求索。 —— 离骚',
  '千里之行，始于足下。 —— 道德经',
];

let _hitokotoCache = '';
let _hitokotoCacheTime = 0;

export function getHermesHitokoto(): string {
  const now = Date.now();
  if (_hitokotoCache && now - _hitokotoCacheTime < 180000) return _hitokotoCache;
  if (now - _hitokotoCacheTime > 30000) {
    _hitokotoCacheTime = now;
    fetch('https://v1.hitokoto.cn/?c=d&c=i&c=k')
      .then((r) => r.json())
      .then((data: any) => {
        if (data && data.hitokoto) {
          const from = data.from_who || data.from || '';
          _hitokotoCache = from ? `💬 「${data.hitokoto}」—— ${from}` : `💬 「${data.hitokoto}」`;
        }
      })
      .catch(() => {});
  }
  const cur = _hitokotoCache;
  if (cur) return cur;
  const q = _fallbackHitokotos[Math.floor(Math.random() * _fallbackHitokotos.length)];
  return q.includes('——') ? `💬 「${q.split('——')[0].trim()}」—— ${q.split('——')[1].trim()}` : `💬 「${q}」`;
}
