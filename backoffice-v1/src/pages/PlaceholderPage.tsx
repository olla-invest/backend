interface PlaceholderPageProps {
  title: string;
  description: string;
  items?: string[];
}

export function PlaceholderPage({ title, description, items }: PlaceholderPageProps) {
  return (
    <div className="page">
      <h1 className="page-title">{title}</h1>
      <section className="placeholder-card">
        <p>{description}</p>
        {items && (
          <ul>
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
