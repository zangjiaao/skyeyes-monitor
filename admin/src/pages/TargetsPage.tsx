import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { TextArea } from "@astryxdesign/core/TextArea";
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
  terms: string;
  exclude_terms: string;
  description: string;
  case_sensitive: number;
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
  const [terms, setTerms] = useState("");
  const [excludeTerms, setExcludeTerms] = useState("");
  const [description, setDescription] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [kind, setKind] = useState("keyword");
  const [editingId, setEditingId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function resetTargetForm() {
    setEditingId("");
    setTargetName("");
    setTerms("");
    setExcludeTerms("");
    setDescription("");
    setCaseSensitive(false);
    setKind("keyword");
  }

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
      <Text type="body" color="secondary">
        一个目标只有一个显示名，检索词一行一条。同一目标的每条检索词会单独搜索，命中都记在这个显示名上。2 到 5 个字母的缩写始终区分大小写并按整词匹配，请写成希望命中的样子，例如 BLA。
      </Text>
      <Selector
        label="国家"
        value={countryId}
        onChange={setCountryId}
        options={countries.map((country) => ({ value: country.id, label: `${country.name} (${country.code})` }))}
        placeholder="选择国家"
      />
      <HStack gap={2}>
        <Selector label="类型" value={kind} onChange={setKind} options={KINDS} />
        <TextInput label="显示名" value={targetName} onChange={setTargetName} description="日报里看到的名称" />
      </HStack>
      <TextArea
        label="检索词"
        rows={5}
        value={terms}
        onChange={setTerms}
        description="一行一条。账号不要带 @。例如 BLA、Balochistan Liberation Army、俾路支解放军。"
      />
      <TextArea
        label="排除词"
        rows={3}
        value={excludeTerms}
        onChange={setExcludeTerms}
        description="可选，一行一条。命中则丢弃，例如 Biologics License、bla bla。"
      />
      <TextArea
        label="背景说明"
        rows={3}
        value={description}
        onChange={setDescription}
        description="可选。交给 DeepSeek 的监测对象说明，例如组织是谁、要关注哪类事件。"
      />
      <CheckboxInput
        label="英文短语区分大小写"
        value={caseSensitive}
        onChange={setCaseSensitive}
        description="2 到 5 个字母的缩写始终区分大小写。这个开关作用于更长的英文短语。"
      />
      <HStack gap={2}>
        <Button
          label={editingId ? "保存修改" : "添加目标"}
          variant="primary"
          onClick={() => {
            setError("");
            const body = JSON.stringify({
              countryId,
              kind,
              name: targetName,
              terms,
              excludeTerms,
              description,
              caseSensitive,
            });
            const request = editingId
              ? api(`/api/targets/${editingId}`, { method: "PATCH", body })
              : api("/api/targets", { method: "POST", body });
            request.then(async () => {
              resetTargetForm();
              setNotice(editingId ? "已保存目标" : "已添加目标");
              await reload();
            }).catch((reason: Error) => setError(reason.message));
          }}
        />
        {editingId ? (
          <Button label="取消编辑" variant="secondary" onClick={resetTargetForm} />
        ) : null}
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
        表头：country_code, kind, name, query, exclude, case_sensitive, enabled。可选 description。query 里多条检索词用 | 或换行分开；同一国家、类型、显示名的多行会合并。也可以用 terms、exclude_terms 这两列表头。kind 为 person、organization、keyword 或 handle。
      </Text>
      <Table
        density="compact"
        idKey="id"
        data={targets}
        columns={[
          { key: "kind", header: "类型" },
          { key: "name", header: "显示名" },
          {
            key: "terms",
            header: "检索词",
            renderCell: (row) => (row.terms || row.query).split(/\r?\n/).filter(Boolean).join(" · "),
          },
          {
            key: "exclude_terms",
            header: "排除词",
            renderCell: (row) => row.exclude_terms?.split(/\r?\n/).filter(Boolean).join(" · ") || "—",
          },
          { key: "case_sensitive", header: "区分大小写", renderCell: (row) => (row.case_sensitive ? "是" : "否") },
          { key: "enabled", header: "启用", renderCell: (row) => (row.enabled ? "是" : "否") },
          {
            key: "actions",
            header: "操作",
            renderCell: (row) => (
              <HStack gap={1}>
                <Button
                  label="编辑"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setEditingId(row.id);
                    setCountryId(row.country_id);
                    setKind(row.kind);
                    setTargetName(row.name);
                    setTerms(row.terms || row.query);
                    setExcludeTerms(row.exclude_terms || "");
                    setDescription(row.description || "");
                    setCaseSensitive(row.case_sensitive === 1);
                    setError("");
                  }}
                />
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
