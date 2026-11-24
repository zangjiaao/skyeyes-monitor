-- 收尾进程的租约。进程中断后，下一次重试可以接着发信，而不是看到 finalizing 就放弃。
ALTER TABLE runs ADD COLUMN finalize_lease_until TEXT;
