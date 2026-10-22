import { readFileSync, existsSync } from 'node:fs';
export const LOCAL = '/data/home/yale/work/tc-verify/corpus/voice-draft-ec';
export const VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'] as const;
export const contexts = (): Record<string, string> => JSON.parse(readFileSync(`${LOCAL}/contexts.json`, 'utf8'));
export const WRONG: Record<string, string> = { EC1: 'EC2', EC2: 'EC3', EC3: 'EC4', EC4: 'EC5', EC5: 'EC6', EC6: 'EC2' };
export const gold = () => JSON.parse(readFileSync(new URL('./gold-v2.json', import.meta.url), 'utf8')).chains as any[];
export const readJsonl = (f: string): any[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
