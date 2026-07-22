// Kept in sync by hand with frontend/src/lib/defaultDocument.ts. Duplicated
// (rather than imported across packages) so the backend has no build-time
// dependency on the frontend; used only to seed a brand-new, never-before-
// compiled collaboration room so joining clients don't see a blank page.
export const DEFAULT_DOCUMENT = String.raw`\documentclass[11pt]{article}
\usepackage[margin=0.9in]{geometry}
\usepackage[hidelinks]{hyperref}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage{xcolor}

\definecolor{accent}{HTML}{2A5DB0}

\titleformat{\section}{\large\bfseries\color{accent}}{}{0em}{}[\titlerule]
\titlespacing{\section}{0pt}{12pt}{6pt}

\pagestyle{empty}
\setlist[itemize]{leftmargin=1.2em, itemsep=2pt, topsep=2pt}

\newcommand{\heading}[2]{%
  \begin{center}
    {\Huge \bfseries #1}\\[4pt]
    {\small #2}
  \end{center}
}

\begin{document}

\heading{Jane Doe}{jane.doe@email.com \quad|\quad (555) 012-3456 \quad|\quad github.com/janedoe}

\section*{Experience}
\textbf{Software Engineer} \hfill \textit{2023 -- Present} \\
Acme Corp \hfill \textit{Remote}
\begin{itemize}
  \item Built a real-time LaTeX compilation pipeline with sub-second incremental rebuilds.
  \item Reduced infrastructure costs by 30\% through container right-sizing.
\end{itemize}

\section*{Education}
\textbf{B.Sc. in Computer Science} \hfill \textit{2019 -- 2023} \\
State University

\section*{Skills}
TypeScript, React, Node.js, Docker, LaTeX

\end{document}
`;
