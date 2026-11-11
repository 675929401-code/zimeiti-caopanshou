/** Keep each existing capability phrase intact while its host wraps the row. */
export function VideoModelCapabilityPhrases({ label }: { label: string }) {
  return (
    <>
      {label.split(" · ").map((phrase, index) => (
        <span className="shrink-0 whitespace-nowrap" data-model-capability-phrase key={`${index}:${phrase}`}>
          {index === 0 ? phrase : ` · ${phrase}`}
        </span>
      ))}
    </>
  );
}
