import { BLOOM_META, type BloomLevel } from "@/lib/bloom";

export default function BloomBadge({ level }: { level: BloomLevel }) {
  return <span className={`badge badge-${level}`}>{BLOOM_META[level].label}</span>;
}
