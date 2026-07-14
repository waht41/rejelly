export function DetailHeader({
  copied,
  id,
  path,
  title,
  onCopy,
}: {
  copied: boolean;
  id: string;
  path: string;
  title: string;
  onCopy: () => void;
}) {
  return (
    <header className="detailHeader">
      <div>
        <div className="detailKicker">
          <span>{id}</span>
          <span>{path}</span>
        </div>
        <h2>{title}</h2>
      </div>
      <button className="copyButton" type="button" onClick={onCopy}>
        {copied ? "Copied" : "Copy path"}
      </button>
    </header>
  );
}
