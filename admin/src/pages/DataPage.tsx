import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { api, formatTime } from "../api";

interface RecordRow extends Record<string, unknown> {
  id: string;
  source: string;
  country_name: string;
  matched_target: string;
  author_name: string;
  original_text: string;
  translation_zh: string | null;
  url: string;
  collected_at: string;
}

export function DataPage() {
  const [view, setView] = useState("all");
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function load(nextView = view) {
    return api<{ records: RecordRow[]; total: number }>(`/api/records?view=${nextView}&limit=50`)
      .then((payload) => {
        setRecords(payload.records);
        setTotal(payload.total);
      });
  }

  useEffect(() => {
    load(view).catch((reason: Error) => setError(reason.message));
    // view 变化时重新拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>数据</Heading>
        <Text type="body" color="secondary">
          {`Excel 固定为 skyeyes.xlsx，每次运行都会用数据库里的全部历史覆盖这一份文件。当前筛选共 ${total} 条。`}
        </Text>
      </VStack>
      {error ? <Banner status="error" title="操作失败" description={error} /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      <HStack gap={2}>
        <Selector
          label="视图"
          value={view}
          onChange={setView}
          options={[
            { value: "all", label: "全部" },
            { value: "today", label: "今日" },
            { value: "yesterday", label: "昨日" },
          ]}
        />
        <Button
          label="手动运行"
          variant="primary"
          onClick={() => {
            setError("");
            api<{ runId: string }>("/api/runs", { method: "POST" })
              .then((result) => setNotice(`已开始运行 ${result.runId}`))
              .catch((reason: Error) => setError(reason.message));
          }}
        />
        <Button
          label="重新生成 Excel"
          variant="secondary"
          onClick={() => {
            api("/api/export/excel", { method: "POST" })
              .then(() => setNotice("已覆盖 skyeyes.xlsx"))
              .catch((reason: Error) => setError(reason.message));
          }}
        />
        <Button
          label="下载 Excel"
          variant="secondary"
          onClick={() => {
            fetch("/api/export/excel")
              .then(async (response) => {
                if (!response.ok) {
                  const payload = await response.json() as { error?: string };
                  throw new Error(payload.error || "下载失败");
                }
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "skyeyes.xlsx";
                anchor.click();
                URL.revokeObjectURL(url);
              })
              .catch((reason: Error) => setError(reason.message));
          }}
        />
      </HStack>
      <Table
        density="compact"
        idKey="id"
        textOverflow="truncate"
        data={records}
        columns={[
          { key: "collected_at", header: "采集", renderCell: (row) => formatTime(row.collected_at) },
          { key: "country_name", header: "国家" },
          { key: "source", header: "来源" },
          { key: "matched_target", header: "目标" },
          { key: "author_name", header: "作者" },
          { key: "original_text", header: "原文" },
          { key: "translation_zh", header: "中文", renderCell: (row) => row.translation_zh || "—" },
          {
            key: "url",
            header: "链接",
            renderCell: (row) => row.url,
          },
        ]}
      />
    </VStack>
  );
}
