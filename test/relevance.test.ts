import { describe, expect, it } from "vitest";
import { modelText, parseRelevanceScore, scoreRelevance } from "../src/domain/relevance";

describe("相关度回复解析", () => {
  it("接受单独整数、JSON 分数，以及夹在说明里的最后一个 0 到 100 整数", () => {
    expect(parseRelevanceScore("72")).toBe(72);
    expect(parseRelevanceScore('{"score": 15}')).toBe(15);
    expect(parseRelevanceScore("85分")).toBe(85);
    expect(parseRelevanceScore("评分：85")).toBe(85);
    expect(parseRelevanceScore("大概 80 分")).toBe(80);
    expect(parseRelevanceScore("0到100，结果是72")).toBe(72);
    expect(parseRelevanceScore("Score: 40")).toBe(40);
  });

  it("拒绝空回复、没有合法分数，以及超出 0 到 100 的数字", () => {
    expect(parseRelevanceScore("")).toBeNull();
    expect(parseRelevanceScore("无法判断")).toBeNull();
    expect(parseRelevanceScore("150")).toBeNull();
    expect(parseRelevanceScore("1000")).toBeNull();
  });

  it("从绑定返回值和 OpenAI 样式里取出正文", () => {
    expect(modelText("85")).toBe("85");
    expect(modelText({ response: "85分" })).toBe("85分");
    expect(modelText({ result: { response: "70" } })).toBe("70");
    expect(modelText({ choices: [{ message: { content: "评分：80" } }] })).toBe("评分：80");
    expect(modelText({ choices: [{ message: { content: [{ text: "61" }] } }] })).toBe("61");
    expect(modelText({})).toBe("");
  });
});

describe("相关度调用", () => {
  it("用模型正文里的分数，并带上监测对象", async () => {
    let sent = "";
    const ai = {
      async run(_model: string, input: { messages: Array<{ content: string }> }) {
        sent = input.messages.map((message) => message.content).join("\n");
        return { response: "85分" };
      },
    } as unknown as Ai;
    await expect(scoreRelevance(ai, "正文讨论 BLA", "BLA")).resolves.toEqual({ score: 85, error: null });
    expect(sent).toContain("BLA");
    expect(sent).toContain("正文讨论 BLA");
  });

  it("读取 choices 里的分数", async () => {
    const ai = {
      async run() {
        return { choices: [{ message: { content: "评分：80" } }] };
      },
    } as unknown as Ai;
    await expect(scoreRelevance(ai, "正文", "目标")).resolves.toEqual({ score: 80, error: null });
  });

  it("模型抛错、空回复和无法解析时返回原因，不向外抛", async () => {
    const thrown = {
      async run() {
        throw new Error("Workers AI 远程调用失败");
      },
    } as unknown as Ai;
    await expect(scoreRelevance(thrown, "正文", "目标")).resolves.toEqual({
      score: null,
      error: "Workers AI 远程调用失败",
    });

    const empty = {
      async run() {
        return { response: "   " };
      },
    } as unknown as Ai;
    await expect(scoreRelevance(empty, "正文", "目标")).resolves.toEqual({
      score: null,
      error: "模型没有返回评分",
    });

    const prose = {
      async run() {
        return { response: "这条不太相关" };
      },
    } as unknown as Ai;
    const parsed = await scoreRelevance(prose, "正文", "目标");
    expect(parsed.score).toBeNull();
    expect(parsed.error).toContain("无法解析评分");
    expect(parsed.error).toContain("这条不太相关");
  });
});
