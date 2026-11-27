import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ApiError, api } from "../api";

interface Country {
  id: string;
  name: string;
  enabled: number | boolean;
}

interface Job extends Record<string, unknown> {
  id: string;
  name: string;
  kind: "schedule" | "manual";
  enabled: number;
  schedule_hour: number | null;
  window_hours: number | null;
  countryIds: string[];
}

const KINDS = [
  { value: "manual", label: "手动" },
  { value: "schedule", label: "定时" },
];

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("manual");
  const [hour, setHour] = useState("8");
  const [windowHours, setWindowHours] = useState("");
  const [allGroups, setAllGroups] = useState(true);
  const [countryIds, setCountryIds] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [runningId, setRunningId] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [pendingJobId, setPendingJobId] = useState("");
  const [deleting, setDeleting] = useState<Job | null>(null);

  const enabledCountries = countries.filter((item) => item.enabled === 1 || item.enabled === true);

  function load() {
    return Promise.all([
      api<{ jobs: Job[] }>("/api/jobs"),
      api<{ countries: Country[] }>("/api/countries"),
    ]).then(([jobPayload, countryPayload]) => {
      setJobs(jobPayload.jobs);
      setCountries(countryPayload.countries);
    });
  }

  useEffect(() => {
    load().catch((reason: Error) => setError(reason.message));
  }, []);

  function openCreate() {
    setEditingId("");
    setName("");
    setKind("manual");
    setHour("8");
    setWindowHours("");
    setAllGroups(true);
    setCountryIds([]);
    setEnabled(true);
    setFormError("");
    setOpen(true);
  }

  function openEdit(job: Job) {
    setEditingId(job.id);
    setName(job.name);
    setKind(job.kind);
    setHour(job.schedule_hour == null ? "8" : String(job.schedule_hour));
    setWindowHours(job.window_hours == null ? "" : String(job.window_hours));
    setAllGroups(job.countryIds.length === 0);
    setCountryIds(job.countryIds);
    setEnabled(job.enabled === 1);
    setFormError("");
    setOpen(true);
  }

  function payload() {
    return {
      name,
      kind,
      enabled,
      scheduleHour: kind === "schedule" ? Number(hour) : null,
      windowHours: windowHours.trim() ? Number(windowHours) : null,
      countryIds: allGroups ? [] : countryIds,
    };
  }

  async function save() {
    setSaving(true);
    setFormError("");
    try {
      if (editingId) {
        await api(`/api/jobs/${editingId}`, { method: "PATCH", body: JSON.stringify(payload()) });
      } else {
        await api("/api/jobs", { method: "POST", body: JSON.stringify(payload()) });
      }
      setOpen(false);
      setNotice(editingId ? "已保存任务" : "已创建任务");
      await load();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function runJob(id: string, confirm = false) {
    setRunningId(id);
    setError("");
    try {
      const result = await api<{ runId: string; warning?: string | null }>(`/api/jobs/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ confirm }),
      });
      setActiveRunId(null);
      setPendingJobId("");
      setNotice(result.warning ? `运行 ${result.runId} 已建立，部分批次没有入队` : `已开始运行 ${result.runId}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "active_run") {
        setPendingJobId(id);
        setActiveRunId(reason.activeRunId ?? "active");
      } else {
        setError(reason instanceof Error ? reason.message : "启动失败");
      }
    } finally {
      setRunningId("");
    }
  }

  function groupLabel(ids: string[]): string {
    if (ids.length === 0) return "全部启用分组";
    return ids.map((id) => countries.find((item) => item.id === id)?.name ?? id).join("、");
  }

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>采集任务</Heading>
        <Text type="body" color="secondary">
          定时任务在配置时区的整点由每小时检查启动，和全局定时互不替代。同一小时只能有一次采集在跑，已经有运行时这次会跳过。手动任务和「立即运行」可以马上开跑，用来试某一组目标。留空的采集窗口跟随全局配置。
        </Text>
      </VStack>
      {error ? <Banner status="error" title="操作失败" description={error} /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      <HStack gap={2}>
        <Button label="新建任务" variant="primary" onClick={openCreate} />
      </HStack>
      <Table
        density="compact"
        idKey="id"
        data={jobs}
        columns={[
          { key: "name", header: "名称" },
          { key: "kind", header: "类型", renderCell: (row) => row.kind === "schedule" ? "定时" : "手动" },
          { key: "schedule_hour", header: "小时", renderCell: (row) => row.kind === "schedule" ? String(row.schedule_hour) : "—" },
          { key: "window_hours", header: "窗口", renderCell: (row) => row.window_hours == null ? "跟随全局" : `${row.window_hours} 小时` },
          { key: "countryIds", header: "分组", renderCell: (row) => groupLabel(row.countryIds) },
          { key: "enabled", header: "启用", renderCell: (row) => row.enabled ? "是" : "否" },
          {
            key: "actions",
            header: "操作",
            renderCell: (row) => (
              <HStack gap={1}>
                <Button label="立即运行" variant="primary" size="sm" isLoading={runningId === row.id} onClick={() => { void runJob(row.id); }} />
                <Button label="编辑" variant="secondary" size="sm" onClick={() => openEdit(row)} />
                <Button label="删除" variant="destructive" size="sm" onClick={() => setDeleting(row)} />
              </HStack>
            ),
          },
        ]}
      />
      <Dialog isOpen={open} purpose="form" width={640} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
        <VStack gap={3}>
          <DialogHeader title={editingId ? "编辑任务" : "新建任务"} onOpenChange={(next) => { if (!saving) setOpen(next); }} />
          {formError ? <Banner status="error" title="无法保存" description={formError} /> : null}
          <TextInput label="名称" value={name} onChange={setName} isDisabled={saving} description="例如：试跑某一分组" />
          <Selector label="类型" value={kind} onChange={setKind} options={KINDS} isDisabled={saving} />
          {kind === "schedule" ? (
            <TextInput
              label="每天运行小时"
              value={hour}
              onChange={setHour}
              isDisabled={saving}
              description="配置时区的 0 到 23 点。和全局定时同一小时时，先开始的那次会占住运行，另一次会跳过。"
            />
          ) : null}
          <TextInput
            label="采集窗口小时"
            value={windowHours}
            onChange={setWindowHours}
            isDisabled={saving}
            description="留空则使用配置页的窗口。测试可以填 1 或 6。"
          />
          <CheckboxInput label="采集全部启用分组" value={allGroups} onChange={setAllGroups} isDisabled={saving} />
          {!allGroups ? (
            <MultiSelector
              label="采集分组"
              placeholder="请选择一个或多个分组"
              value={countryIds}
              onChange={setCountryIds}
              options={enabledCountries.map((item) => ({ value: item.id, label: item.name }))}
              hasSearch
              hasClear
              triggerDisplay="labels"
              emptyText="没有已启用的分组"
              isDisabled={saving}
            />
          ) : null}
          <CheckboxInput label="启用" value={enabled} onChange={setEnabled} isDisabled={saving} description="停用的定时任务不会到点启动。立即运行不受这个开关影响。" />
          <HStack gap={2}>
            <Button label={editingId ? "保存修改" : "创建任务"} variant="primary" isLoading={saving} onClick={() => { void save(); }} />
            <Button label="取消" variant="secondary" isDisabled={saving} onClick={() => setOpen(false)} />
          </HStack>
        </VStack>
      </Dialog>
      <Dialog
        isOpen={activeRunId !== null}
        purpose="form"
        width={440}
        onOpenChange={(next) => { if (!next && !runningId) setActiveRunId(null); }}
      >
        <VStack gap={3}>
          <DialogHeader title="已有运行进行中" onOpenChange={(next) => { if (!next && !runningId) setActiveRunId(null); }} />
          <Text type="body">另一次采集还没结束。取消它的未完成批次后，将开始这个任务。已经完成的批次会保留。</Text>
          <HStack gap={2}>
            <Button label="取消进行中的运行并开始" variant="primary" isLoading={Boolean(runningId)} onClick={() => { void runJob(pendingJobId, true); }} />
            <Button label="留下当前运行" variant="secondary" isDisabled={Boolean(runningId)} onClick={() => setActiveRunId(null)} />
          </HStack>
        </VStack>
      </Dialog>
      <Dialog
        isOpen={deleting !== null}
        purpose="form"
        width={440}
        onOpenChange={(next) => { if (!next) setDeleting(null); }}
      >
        <VStack gap={3}>
          <DialogHeader title="删除任务" onOpenChange={(next) => { if (!next) setDeleting(null); }} />
          <Text type="body">{`删除「${deleting?.name ?? ""}」后，它不会再按时启动。已经产生的运行记录会保留。`}</Text>
          <HStack gap={2}>
            <Button
              label="删除"
              variant="destructive"
              onClick={() => {
                const job = deleting;
                if (!job) return;
                api(`/api/jobs/${job.id}`, { method: "DELETE" })
                  .then(async () => {
                    setDeleting(null);
                    setNotice("已删除任务");
                    await load();
                  })
                  .catch((reason: Error) => setError(reason.message));
              }}
            />
            <Button label="取消" variant="secondary" onClick={() => setDeleting(null)} />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
