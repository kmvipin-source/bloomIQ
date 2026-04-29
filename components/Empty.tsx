export default function Empty({
  title,
  body,
  icon = "📭",
  action,
}: {
  title: string;
  body?: string;
  icon?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card text-center py-16 px-6">
      <div className="text-5xl mb-3">{icon}</div>
      <div className="h2 mb-1">{title}</div>
      {body && <p className="muted text-sm max-w-md mx-auto">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
