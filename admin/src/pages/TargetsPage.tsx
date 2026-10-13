import { useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
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

const IMPORT_HELP = [
  ["目标ID", "留空则新建；填写导出的 ID 则覆盖该目标；删行不会删除数据库里的目标。"],
  ["国家代码", "必须是这里已经建好的国家代码，例如 pk。"],
  ["类型", "person 人物、organization 机构、keyword 关键词、handle X 账号。也可以写中文。"],
  ["显示名", "日报里的名称。没有目标 ID 时，同一国家、类型、显示名的多行会合并。"],
  ["检索词", "必填。多条用 | 或单元格里的换行分开。账号不要带 @。带目标 ID 的行会按文件里的检索词整列覆盖。"],
  ["排除词", "可选。规则与检索词相同，命中就丢掉整条。"],
  ["背景说明", "可选。交给 AI 解读，最多 800 字。"],
  ["启用", "1 或 是 为启用，0 或 否 为停用。留空视为启用。"],
  ["英文短语区分大小写", "可选。1 或 是 时，更长的英文短语也区分大小写。缩写始终区分大小写。"],
];

const ACTION_LABEL = {
  create: "新建",
  update: "更新",
  unchanged: "无变化",
} as const;

interface ImportPreviewRow extends Record<string, unknown> {
  line: number;
  id: string;
  action: keyof typeof ACTION_LABEL;
  countryCode: string;
  kind: string;
  name: string;
  terms: string[];
  excludeTerms: string[];
  errors: string[];
  duplicateOf: number | null;
}

interface ImportPreview {
  rows: ImportPreviewRow[];
  errorCount: number;
  duplicateCount: number;
}

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
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [importing, setImporting] = useState(false);
  const [exportCurrentCountry, setExportCurrentCountry] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function downloadTemplate(format: "csv" | "xlsx") {
    setError("");
    const response = await fetch(`/api/targets/template.${format}`);
    if (!response.ok) {
      setError("模板下载失败");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = format === "csv" ? "skyeyes-targets-template.csv" : "skyeyes-targets-template.xlsx";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function downloadExport(format: "csv" | "xlsx") {
    setError("");
    const params = exportCurrentCountry && countryId ? `?countryId=${encodeURIComponent(countryId)}` : "";
    const response = await fetch(`/api/targets/export.${format}${params}`);
    if (!response.ok) {
      setError("导出失败");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = format === "csv" ? "skyeyes-targets.csv" : "skyeyes-targets.xlsx";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadPreview(file: File) {
    setImportFile(file);
    setPreview(null);
    setPreviewError("");
    setImporting(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const result = await api<ImportPreview>("/api/targets/import/preview", { method: "POST", body: form });
      setPreview(result);
    } catch (reason) {
      setPreviewError(reason instanceof Error ? reason.message : "无法预览");
    } finally {
      setImporting(false);
    }
  }

  async function commitImport() {
    if (!importFile || !preview || preview.errorCount > 0) return;
    setImporting(true);
    setPreviewError("");
    try {
      const form = new FormData();
      form.set("file", importFile);
      const result = await api<{ created: number; updated: number; unchanged: number }>("/api/targets/import", { method: "POST", body: form });
      setImportOpen(false);
      setImportFile(null);
      setPreview(null);
      setNotice(`新建 ${result.created} 条，更新 ${result.updated} 条，无变化 ${result.unchanged} 条`);
      await reload();
    } catch (reason) {
      setPreviewError(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setImporting(false);
    }
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
      <HStack gap={2}>
        <Button label="导出 CSV" variant="secondary" onClick={() => { void downloadExport("csv"); }} />
        <Button label="导出 Excel" variant="secondary" onClick={() => { void downloadExport("xlsx"); }} />
        <CheckboxInput
          label="只导出当前国家"
          value={exportCurrentCountry}
          onChange={setExportCurrentCountry}
        />
        <Button label="导入 CSV / Excel" variant="secondary" onClick={() => setImportOpen(true)} />
      </HStack>
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
      <Dialog
        isOpen={importOpen}
        purpose="form"
        width={760}
        onOpenChange={(open) => {
          if (!open && !importing) {
            setImportOpen(false);
            setPreview(null);
            setImportFile(null);
            setPreviewError("");
          }
        }}
      >
        <VStack gap={3}>
          <DialogHeader
            title="导入目标"
            onOpenChange={(open) => {
              if (!open && !importing) setImportOpen(false);
            }}
          />
          <Text type="body">
            导出的表格和模板列相同，改完可以再导入。目标 ID 留空会新建；填写导出的 ID 会覆盖该目标。文件里没有的目标会保留，只有页面上的删除才会删掉目标。
          </Text>
          <VStack gap={1}>
            {IMPORT_HELP.map(([label, help]) => (
              <Text key={label} type="supporting" color="secondary">{`${label}：${help}`}</Text>
            ))}
          </VStack>
          <HStack gap={2}>
            <Button label="下载 CSV 模板" variant="secondary" onClick={() => { void downloadTemplate("csv"); }} />
            <Button label="下载 Excel 模板" variant="secondary" onClick={() => { void downloadTemplate("xlsx"); }} />
            <Button label="选择文件" variant="primary" onClick={() => fileRef.current?.click()} />
          </HStack>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void loadPreview(file);
            }}
          />
          {importFile ? <Text type="supporting">{`已选 ${importFile.name}`}</Text> : null}
          {previewError ? <Banner status="error" title="无法导入" description={previewError} /> : null}
          {preview && preview.duplicateCount > 0 ? (
            <Banner status="warning" title={`${preview.duplicateCount} 行与前面的目标重复，确认后会合并检索词和排除词`} />
          ) : null}
          {preview && preview.errorCount > 0 ? (
            <Banner status="error" title={`${preview.errorCount} 行有错误，改正文件后再导入`} />
          ) : null}
          {preview ? (
            <Text type="supporting">
              {`新建 ${preview.rows.filter((row) => row.errors.length === 0 && row.action === "create").length}，更新 ${preview.rows.filter((row) => row.errors.length === 0 && row.action === "update").length}，无变化 ${preview.rows.filter((row) => row.errors.length === 0 && row.action === "unchanged").length}。文件中没有的目标不会删除。`}
            </Text>
          ) : null}
          {preview ? (
            <Table
              density="compact"
              idKey="line"
              textOverflow="truncate"
              data={preview.rows}
              columns={[
                { key: "line", header: "行" },
                { key: "countryCode", header: "国家代码" },
                { key: "kind", header: "类型" },
                { key: "name", header: "显示名" },
                { key: "terms", header: "检索词", renderCell: (row) => row.terms.join(" | ") || "—" },
                {
                  key: "errors",
                  header: "检查",
                  renderCell: (row) => {
                    const notes = [...row.errors];
                    if (row.duplicateOf) notes.push(`与第 ${row.duplicateOf} 行重复，将合并`);
                    if (notes.length > 0) return notes.join("；");
                    return ACTION_LABEL[row.action];
                  },
                },
              ]}
            />
          ) : null}
          <HStack gap={2}>
            <Button
              label="确认导入"
              variant="primary"
              isLoading={importing}
              isDisabled={!preview || preview.errorCount > 0 || preview.rows.length === 0}
              onClick={() => { void commitImport(); }}
            />
            <Button
              label="取消"
              variant="secondary"
              isDisabled={importing}
              onClick={() => {
                setImportOpen(false);
                setPreview(null);
                setImportFile(null);
                setPreviewError("");
              }}
            />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
