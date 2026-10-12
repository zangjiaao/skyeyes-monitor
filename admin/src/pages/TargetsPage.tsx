import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { api } from "../api";

interface Country {
  id: string;
  name: string;
  code: string;
  enabled: number;
}

interface Target extends Record<string, unknown> {
  id: string;
  country_id: string;
  kind: string;
  name: string;
  query: string;
  enabled: number;
}

const KINDS = [
  { value: "person", label: "人物" },
  { value: "organization", label: "机构" },
  { value: "keyword", label: "关键词" },
  { value: "handle", label: "X 账号" },
];

export function TargetsPage() {
  const [countries, setCountries] = useState<Country[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [countryId, setCountryId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [targetName, setTargetName] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("keyword");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function reload() {
    const payload = await api<{ countries: Country[] }>("/api/countries");
    setCountries(payload.countries);
    const selected = countryId || payload.countries[0]?.id || "";
    if (!countryId && selected) setCountryId(selected);
    const targetPayload = await api<{ targets: Target[] }>(
      selected ? `/api/targets?countryId=${encodeURIComponent(selected)}` : "/api/targets",
    );
    setTargets(targetPayload.targets);
  }

  useEffect(() => {
    reload().catch((reason: Error) => setError(reason.message));
    // 首次进入页面加载名单。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!countryId) return;
    api<{ targets: Target[] }>(`/api/targets?countryId=${encodeURIComponent(countryId)}`)
      .then((payload) => setTargets(payload.targets))
      .catch((reason: Error) => setError(reason.message));
  }, [countryId]);

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>监测目标</Heading>
        <Text type="body" color="secondary">
          国家和目标只存在数据库里。种子数据是占位示例，上线前请删掉并导入真实名单。
        </Text>
      </VStack>
      {error ? <Banner status="error" title="操作失败" description={error} /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      <Heading level={2}>国家</Heading>
      <HStack gap={2}>
        <TextInput label="名称" value={name} onChange={setName} />
        <TextInput label="代码" value={code} onChange={setCode} description="小写字母、数字、连字符" />
        <Button
          label="添加国家"
          variant="primary"
          onClick={() => {
            setError("");
            api("/api/countries", { method: "POST", body: JSON.stringify({ name, code }) })
              .then(async () => {
                setName("");
                setCode("");
                await reload();
              })
              .catch((reason: Error) => setError(reason.message));
          }}
        />
      </HStack>
      <Table
        density="compact"
        idKey="id"
        data={countries as Array<Country & Record<string, unknown>>}
        columns={[
          { key: "name", header: "名称" },
          { key: "code", header: "代码" },
          { key: "enabled", header: "启用", renderCell: (row) => (row.enabled ? "是" : "否") },
          {
            key: "actions",
            header: "操作",
            renderCell: (row) => (
              <HStack gap={1}>
                <Button
                  label={row.enabled ? "停用" : "启用"}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    api(`/api/countries/${row.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ enabled: !row.enabled }),
                    }).then(reload).catch((reason: Error) => setError(reason.message));
                  }}
                />
                <Button
                  label="删除"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    api(`/api/countries/${row.id}`, { method: "DELETE" })
                      .then(reload)
                      .catch((reason: Error) => setError(reason.message));
                  }}
                />
              </HStack>
            ),
          },
        ]}
      />
      <Heading level={2}>目标</Heading>
      <Selector
        label="国家"
        value={countryId}
        onChange={setCountryId}
        options={countries.map((country) => ({ value: country.id, label: `${country.name} (${country.code})` }))}
        placeholder="选择国家"
      />
      <HStack gap={2}>
        <Selector label="类型" value={kind} onChange={setKind} options={KINDS} />
        <TextInput label="名称" value={targetName} onChange={setTargetName} />
        <TextInput label="检索词" value={query} onChange={setQuery} description="账号不要带 @" />
        <Button
          label="添加目标"
          variant="primary"
          onClick={() => {
            setError("");
            api("/api/targets", {
              method: "POST",
              body: JSON.stringify({ countryId, kind, name: targetName, query: query || targetName }),
            }).then(async () => {
              setTargetName("");
              setQuery("");
              await reload();
            }).catch((reason: Error) => setError(reason.message));
          }}
        />
      </HStack>
      <Button
        label="导入 CSV / Excel"
        variant="secondary"
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".csv,.xlsx";
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const form = new FormData();
            form.set("file", file);
            api<{ imported: number }>("/api/targets/import", { method: "POST", body: form })
              .then(async (result) => {
                setNotice(`已导入 ${result.imported} 条`);
                await reload();
              })
              .catch((reason: Error) => setError(reason.message));
          };
          input.click();
        }}
      />
      <Text type="supporting" color="secondary">
        表头：country_code, kind, name, query, enabled。kind 为 person、organization、keyword 或 handle。
      </Text>
      <Table
        density="compact"
        idKey="id"
        data={targets}
        columns={[
          { key: "kind", header: "类型" },
          { key: "name", header: "名称" },
          { key: "query", header: "检索词" },
          { key: "enabled", header: "启用", renderCell: (row) => (row.enabled ? "是" : "否") },
          {
            key: "actions",
            header: "操作",
            renderCell: (row) => (
              <HStack gap={1}>
                <Button
                  label={row.enabled ? "停用" : "启用"}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    api(`/api/targets/${row.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ enabled: !row.enabled }),
                    }).then(reload).catch((reason: Error) => setError(reason.message));
                  }}
                />
                <Button
                  label="删除"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    api(`/api/targets/${row.id}`, { method: "DELETE" })
                      .then(reload)
                      .catch((reason: Error) => setError(reason.message));
                  }}
                />
              </HStack>
            ),
          },
        ]}
      />
    </VStack>
  );
}
