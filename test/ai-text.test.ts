import { describe, expect, it, vi } from "vitest";
import { prepareAiText } from "../src/domain/ai-text";
import { translateToChinese } from "../src/translate";
import { callDeepseek, TEXT_LIMIT } from "../src/ai/interpret";

const TOKENIZER_ERROR = "3030: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]";
const chinese = "日本与台湾之间的经济关系取得了新的进展。";
const validUtf16 = (text: string) => {
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return false;
  }
  return true;
};

describe("模型输入清理", () => {
  it.each([null, undefined, 123, [], {}, new Uint8Array([65])])("拒绝非字符串，不把 %j 强转为正文", (value) => {
    expect(prepareAiText(value, 1200).text).toBeNull();
    expect(prepareAiText(value, 1200).error).toContain("必须是字符串");
  });
  it("保留多语言文字、emoji 与连接符，替换控制字符和孤立代理项", () => {
    const result = prepareAiText('\uFEFFAlpha\u0000Beta\u0007\r\nCafe\u0301 👩‍💻 فارسی تازه‌ای \ud800x\udc00', 1200);
    expect(result.text).toBe('Alpha Beta \nCafé 👩‍💻 فارسی تازه‌ای �x�');
    expect(result.replacements).toBe(4);
    expect(validUtf16(result.text!)).toBe(true);
    expect(result.inputBytes).toBe(new TextEncoder().encode(result.text!).length);
  });
  it("不会在长度边界把 emoji 截成半个字符", () => {
    const result = prepareAiText('a'.repeat(1199) + '🚀more', 1200);
    expect(result.text).toBe('a'.repeat(1199));
    expect(result.truncated).toBe(true);
    expect(prepareAiText('a'.repeat(1198) + '🚀more', 1200).text).toBe('a'.repeat(1198) + '🚀');
  });
  it("空输入不消耗模型调用，中文直通保留完整正文", async () => {
    const run = vi.fn();
    const ai = { run } as unknown as Ai;
    expect((await translateToChinese(ai, '\u0000\u0007\r\n')).status).toBe('translation_failed');
    const long = '这是一条中文消息。'.repeat(300);
    expect((await translateToChinese(ai, long)).text).toBe(long);
    expect((await translateToChinese(ai, null as unknown as string)).error).toContain('必须是字符串');
    expect((await translateToChinese(ai, ['text'] as unknown as string)).error).toContain('必须是字符串');
    expect(run).not.toHaveBeenCalled();
  });
  it("两个翻译模型都接收清理后的字符串，原始正文保持不变", async () => {
    const original = 'a'.repeat(1199) + '🚀more\u0000';
    const payloads: Array<Record<string, unknown>> = [];
    const ai = { async run(model: string, input: Record<string, unknown>) {
      payloads.push(input);
      return model.includes('m2m100') ? { translated_text: '' } : { response: chinese };
    } } as unknown as Ai;
    expect((await translateToChinese(ai, original)).status).toBe('ok');
    expect(payloads[0].text).toBe('a'.repeat(1199));
    expect((payloads[1].messages as Array<{ content: string }>)[1].content.endsWith('a'.repeat(1199))).toBe(true);
    expect(original.endsWith('🚀more\u0000')).toBe(true);
  });
  it("分词器错误会回退，记录模型和输入元数据，不记录正文", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ai = { async run(model: string) {
        if (model.includes('m2m100')) throw new Error(TOKENIZER_ERROR);
        return { response: chinese };
      } } as unknown as Ai;
      expect((await translateToChinese(ai, 'Sensitive original article.')).status).toBe('ok');
      const entry = JSON.parse(warn.mock.calls[0][0]);
      expect(entry).toMatchObject({ model: '@cf/meta/m2m100-1.2b', code: 3030, inputType: 'string', sentLength: 27 });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Sensitive original article.');
    } finally { warn.mockRestore(); }
  });
  it("识别返回体中的分词器错误，不把错误对象当成译文", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ai = { async run() { return { errors: [{ code: 3030, message: TOKENIZER_ERROR }] }; } } as unknown as Ai;
      const result = await translateToChinese(ai, 'An ordinary English paragraph.');
      expect(result.status).toBe('translation_failed');
      expect(result.error).toContain('@cf/zai-org/glm-4.7-flash');
      expect(result.error).toContain('3030');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });
  it("DeepSeek 的正文边界也不会生成孤立代理项", async () => {
    let prompt = '';
    await callDeepseek({
      apiKey: 'test-key', model: 'deepseek-chat', text: 'a'.repeat(TEXT_LIMIT - 1) + '🚀tail',
      targetName: 'Target', terms: [], description: '',
      fetchImpl: async (_url, init) => {
        prompt = (JSON.parse(String(init?.body)).messages as Array<{content: string}>)[1].content;
        return Response.json({ choices: [{ message: { content: JSON.stringify({ score: 80, relevant: true, translation_zh: chinese }) } }] });
      },
    });
    expect(validUtf16(prompt)).toBe(true);
    expect(prompt.endsWith('a'.repeat(TEXT_LIMIT - 1))).toBe(true);
  });
});
