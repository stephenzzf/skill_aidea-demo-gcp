import type { DemoStep, DomainPage, SolutionBlueprint, SolutionDesign } from "../shared/spec.ts";
import { isPlannedDomain } from "../shared/solution.ts";
import "./solution-overview.css";

interface SolutionOverviewProps {
  customer: string;
  goal: string;
  solution: string;
  design: SolutionDesign;
  blueprint: SolutionBlueprint;
  pages: DomainPage[];
  steps: DemoStep[];
  roles: Array<{ id: string; label: string }>;
  onNavigate: (pageId: string) => void;
}

const coverageText = {
  unverified: "已实现 · 待验证",
  simulated: "模拟验证",
  verified: "已验证",
  planned: "后续接入",
} as const;

const sourceStatus = {
  observed: "页面已观察",
  confirmed: "客户已确认",
  hypothesis: "待验证假设",
  unavailable: "暂不可访问",
} as const;

const systemStatus = {
  connected: "已接入",
  simulated: "演示模拟",
  planned: "计划接入",
} as const;

export function SolutionOverview({ customer, goal, solution, design, blueprint, pages, steps, roles, onNavigate }: SolutionOverviewProps) {
  const statusClasses = (status: string) => `so-status so-status-${status}`;
  const roleLabels = new Map(roles.map((role) => [role.id, role.label]));

  return (
    <section className="so-overview" aria-labelledby="so-title">
      <div className="so-hero">
        <span className="so-eyebrow">已确认方案 · {customer}</span>
        <h2 id="so-title">{goal}</h2>
        <p>{solution}</p>
        <div className="so-hero-meta">
          <span>完整业务方案</span><span>{pages.length} 个业务领域</span><span>{steps.length} 个演示验证步骤</span>
        </div>
      </div>

      <section className="so-section" aria-labelledby="so-objectives-title">
        <div className="so-section-heading"><span>01</span><div><h3 id="so-objectives-title">目标与衡量</h3><p>成功标准来自已确认目标；基线未提供时保留为待核实。</p></div></div>
        {blueprint.objectives.length ? <div className="so-objectives">{blueprint.objectives.map((objective) =>
          <article className="so-objective" key={objective.id}><strong>{objective.title}</strong><p>{objective.measure}</p></article>,
        )}</div> : <p className="so-empty">方案尚未配置衡量目标。</p>}
      </section>

      <section className="so-section" aria-labelledby="so-journey-title">
        <div className="so-section-heading"><span>02</span><div><h3 id="so-journey-title">角色与业务旅程</h3><p>沿同一业务目标查看各角色、步骤和领域交接。</p></div></div>
        {blueprint.journey.length ? <ol className="so-journey">{blueprint.journey.map((item, index) => {
          const page = item.domainId ? pages.find((candidate) => candidate.id === item.domainId) : undefined;
          return <li className="so-journey-item" key={item.id}>
            <span className="so-step-number">{String(index + 1).padStart(2, "0")}</span>
            <div><div className="so-journey-title"><strong>{item.title}</strong><span>{roleLabels.get(item.role) ?? item.role}</span></div><p>{item.description}</p>
              {page && (isPlannedDomain(page, design.coverage)
                ? <span className="so-planned-label">「{page.title}」为后续接入领域</span>
                : <button className="so-text-link" type="button" onClick={() => onNavigate(page.id)}>打开「{page.title}」<span aria-hidden="true">↗</span></button>)}
              {item.next?.length ? <small>后续交接：{item.next.map((id) => blueprint.journey.find((next) => next.id === id)?.title ?? id).join("、")}</small> : null}
            </div>
          </li>;
        })}</ol> : <p className="so-empty">方案尚未配置业务旅程。</p>}
      </section>

      <section className="so-section" aria-labelledby="so-domains-title">
        <div className="so-section-heading"><span>03</span><div><h3 id="so-domains-title">业务领域</h3><p>每个领域包含方案职责、演示能力与可验证主张。</p></div></div>
        {pages.length ? <div className="so-domain-grid">{pages.map((page, index) => {
          const claims = design.coverage.filter((claim) => page.claimIds.includes(claim.id ?? ""));
          const planned = claims.some((claim) => claim.status === "planned");
          const plannedOnly = isPlannedDomain(page, design.coverage);
          return <article className="so-domain-card" key={page.id}>
            <span className="so-domain-index">领域 {String(index + 1).padStart(2, "0")}</span>
            <h4>{page.title}</h4><p>{page.goal}</p>
            <div className="so-chip-row">{page.components.filter((item) => item !== "assistant").map((component) => <span key={component}>{({ metrics: "分析", records: "业务记录", workflow: "处理流程" })[component]}</span>)}{page.components.includes("assistant") && <span>首页问答可参考</span>}</div>
            <div className="so-domain-foot"><span>{claims.length} 项验证主张</span>
              {plannedOnly
                ? <span className="so-planned-label">后续接入 · 当前仅展示范围</span>
                : <>
                  {planned && <span className="so-planned-label">含后续接入能力</span>}
                  <button className="so-text-link" type="button" onClick={() => onNavigate(page.id)}>进入领域 <span aria-hidden="true">→</span></button>
                </>}
            </div>
          </article>;
        })}</div> : <p className="so-empty">方案尚未配置业务领域。</p>}
      </section>

      <div className="so-two-column">
        <section className="so-section" aria-labelledby="so-sources-title">
          <div className="so-section-heading"><span>04</span><div><h3 id="so-sources-title">方案依据</h3><p>事实、客户确认和假设分开记录。</p></div></div>
          <div className="so-source-list">
            {design.facts.map((fact, index) => <article className="so-source" key={`fact-${index}`}><span className={statusClasses("observed")}>方案事实</span><p>{fact}</p></article>)}
            {blueprint.sources.map((source) => <article className="so-source" key={source.id}>
              <span className={statusClasses(source.status)}>{sourceStatus[source.status]}</span>
              <strong>{source.title}{source.region ? ` · ${source.region}` : ""}</strong><p>{source.finding}</p>
              {source.url && <a href={source.url} target="_blank" rel="noreferrer">查看来源<span aria-hidden="true"> ↗</span></a>}
              {source.checkedAt && <small>检查时间：{source.checkedAt}</small>}
              {source.evidence && <small>证据：{source.evidence}</small>}
            </article>)}
            {design.assumptions.map((assumption, index) => <article className="so-source" key={`assumption-${index}`}><span className={statusClasses("hypothesis")}>待核实假设</span><p>{assumption}</p></article>)}
          </div>
        </section>

        <section className="so-section" aria-labelledby="so-systems-title">
          <div className="so-section-heading"><span>05</span><div><h3 id="so-systems-title">数据与系统边界</h3><p>区分演示状态与真实业务接入。</p></div></div>
          <div className="so-system-list">{blueprint.systems.map((system) => <article className="so-system" key={system.id}>
            <div><strong>{system.name}</strong><p>{system.responsibility}</p></div><span className={statusClasses(system.status)}>{systemStatus[system.status]}</span>
          </article>)}</div>
          {blueprint.dataNotes.length > 0 && <ul className="so-data-notes">{blueprint.dataNotes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul>}
        </section>
      </div>

      <section className="so-section" aria-labelledby="so-phases-title">
        <div className="so-section-heading"><span>06</span><div><h3 id="so-phases-title">实施阶段</h3><p>当前 Demo 的边界和后续依赖。</p></div></div>
        <div className="so-phase-list">{blueprint.phases.map((phase, index) => <article className="so-phase" key={phase.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{phase.title}</strong><p>{phase.description}</p></div></article>)}</div>
        {design.implementation.length > 0 && <details className="so-implementation"><summary>查看实施说明</summary><ul>{design.implementation.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></details>}
      </section>

      <section className="so-section" aria-labelledby="so-coverage-title">
        <div className="so-section-heading"><span>07</span><div><h3 id="so-coverage-title">方案主张与 Demo 验证</h3><p>方案中包含后续能力时，这里标出实现状态和依据。</p></div></div>
        <div className="so-coverage-list">{design.coverage.map((claim) => {
          const linkedStep = steps.some((step) => step.claimIds?.includes(claim.id ?? ""));
          const claimPages = pages.filter((page) => page.claimIds.includes(claim.id ?? ""));
          return <article className="so-coverage" key={claim.id ?? claim.claim}>
            <span className={statusClasses(claim.status)}>{coverageText[claim.status]}</span>
            <div><strong>{claim.claim}</strong><p>{claim.evidence}</p></div>
            <div className="so-coverage-links">{linkedStep && <span className="so-step-linked">关联演示步骤</span>}
            {claim.status !== "planned" && claimPages.map((page) => <button className="so-text-link" key={page.id} type="button" onClick={() => onNavigate(page.id)}>打开「{page.title}」<span aria-hidden="true">→</span></button>)}
            </div>
          </article>;
        })}</div>
        {steps.length > 0 && <details className="so-steps"><summary>查看 {steps.length} 个演示验证步骤</summary><ol>{steps.map((step, index) => {
          const page = pages.find((candidate) => candidate.id === step.pageId);
          return <li key={step.id ?? `${index}-${step.question}`}><strong>{step.question}</strong><span>角色：{step.role} · 页面：{page?.title ?? "方案总览"}</span>
            {step.preconditions?.length ? <p>前置：{step.preconditions.join("；")}</p> : null}
            {step.inputs?.length ? <p>操作：{step.inputs.join("；")}</p> : null}
            <p>预期：{step.expected} · 观察：{step.observation ?? step.expected}</p>
          </li>;
        })}</ol></details>}
      </section>
    </section>
  );
}
