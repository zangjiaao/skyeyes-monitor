import { describe, expect, it } from "vitest";
import { identityFromAccessPayload, isServiceTokenIdentity } from "../src/auth/access";

describe("Access 身份", () => {
  it("优先使用邮箱", () => {
    expect(identityFromAccessPayload({ email: " Ops@Example.com ", common_name: "排查令牌" })).toBe("ops@example.com");
  });

  it("Service Token 没有邮箱时使用令牌名称", () => {
    expect(identityFromAccessPayload({ common_name: " 排查令牌 " })).toBe("service-token:排查令牌");
    expect(isServiceTokenIdentity("service-token:排查令牌")).toBe(true);
  });

  it("既没有邮箱也没有令牌名称时拒绝", () => {
    expect(() => identityFromAccessPayload({})).toThrow("Access JWT 缺少 email");
    expect(isServiceTokenIdentity("ops@example.com")).toBe(false);
  });
});
