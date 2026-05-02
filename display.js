import { Chess } from "chess.js";
import { Chessground } from "@lichess-org/chessground";
import problemsData from "./problems.json";
import { choice } from "./random.js";

const { problems } = problemsData;

const TOTAL_PROBLEMS = problems.length;
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const SOLVED_STORAGE_KEY = "polgarSolvedPuzzles";
const SIDEBAR_STORAGE_KEY = "polgarPuzzleSidebarCollapsed";
const PROMOTION_OPTIONS = [
  { promotion: "q", role: "queen", label: "Queen" },
  { promotion: "n", role: "knight", label: "Knight" },
  { promotion: "r", role: "rook", label: "Rook" },
  { promotion: "b", role: "bishop", label: "Bishop" }
];

let urlParameters = getUrlParameters();
let board;
let game;
let correctMoves = [];
let currentProblem;
let currentLastMove;
let waitingForReply = false;
let appElement;
let nextButton;
let problemBrowser;
let browserList;
let sidebarToggle;
let helpWidget;
let helpToggle;
let helpPanel;
let activeProblemButton;
let solvedProblemIds = new Set();
let pendingPromotion;
let promotionChoiceElement;

function getUrlParameters() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

function writeUrlParameters(replace = false) {
  if (!window.history) {
    return;
  }

  const url = new URL(window.location.href);
  url.search = "";
  Object.entries(urlParameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  });

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ ...urlParameters }, "", url.toString());
}

function updateProblemUrl(problemId, replace = false) {
  if (!window.history) {
    return;
  }

  urlParameters.id = `${problemId}`;
  if (!replace && window.history.state && Number(window.history.state.id) === problemId) {
    return;
  }

  writeUrlParameters(replace);
}

function parseMove(move) {
  let [source, target] = move.split("-");
  const promotion = target.length === 2 ? "q" : target[2];
  target = target.slice(0, 2);
  return { source, target, promotion };
}

function colorName(turn) {
  return turn === "w" ? "white" : "black";
}

function promotionOptionFromKey(key) {
  return PROMOTION_OPTIONS.find((option) => option.promotion === key.toLowerCase());
}

function pieceFen(fen) {
  return fen.split(" ")[0];
}

function isHelpOpen() {
  return Boolean(helpPanel && !helpPanel.hidden);
}

function setHelpOpen(isOpen) {
  if (!helpToggle || !helpPanel) {
    return;
  }

  helpPanel.hidden = !isOpen;
  helpToggle.setAttribute("aria-expanded", `${isOpen}`);
  helpToggle.setAttribute("aria-label", isOpen ? "Hide controls help" : "Show controls help");
}

function toggleHelp() {
  setHelpOpen(!isHelpOpen());
}

function handleHelpDocumentClick(event) {
  if (isHelpOpen() && helpWidget && !helpWidget.contains(event.target)) {
    setHelpOpen(false);
  }
}

function readSolvedProblemIds() {
  try {
    const storedValue = window.sessionStorage.getItem(SOLVED_STORAGE_KEY);
    if (!storedValue) {
      return new Set();
    }

    const problemIds = JSON.parse(storedValue);
    if (!Array.isArray(problemIds)) {
      return new Set();
    }

    return new Set(
      problemIds
        .map((problemId) => Number(problemId))
        .filter((problemId) => Number.isInteger(problemId) && problemId >= 1 && problemId <= TOTAL_PROBLEMS)
    );
  } catch {
    return new Set();
  }
}

function writeSolvedProblemIds() {
  try {
    window.sessionStorage.setItem(SOLVED_STORAGE_KEY, JSON.stringify([...solvedProblemIds]));
  } catch {
    // Keep the in-memory set even when browser storage is blocked.
  }
}

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(isCollapsed) {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, `${isCollapsed}`);
  } catch {
    // Keep the visual state even when browser storage is blocked.
  }
}

function redrawBoardAfterLayoutChange() {
  if (!board || typeof board.redrawAll !== "function") {
    return;
  }

  window.requestAnimationFrame(() => board.redrawAll());
  window.setTimeout(() => board.redrawAll(), 180);
}

function setSidebarCollapsed(isCollapsed, persist = true) {
  if (!appElement || !sidebarToggle || !browserList) {
    return;
  }

  appElement.classList.toggle("sidebar-collapsed", isCollapsed);
  browserList.hidden = isCollapsed;
  sidebarToggle.dataset.direction = isCollapsed ? "expand" : "collapse";
  sidebarToggle.setAttribute("aria-expanded", `${!isCollapsed}`);
  sidebarToggle.setAttribute(
    "aria-label",
    isCollapsed ? "Expand puzzle sidebar" : "Collapse puzzle sidebar"
  );
  sidebarToggle.title = isCollapsed ? "Expand puzzle sidebar" : "Collapse puzzle sidebar";

  if (persist) {
    writeSidebarCollapsed(isCollapsed);
  }

  redrawBoardAfterLayoutChange();
}

function toggleSidebar() {
  setSidebarCollapsed(!appElement.classList.contains("sidebar-collapsed"));
}

function problemButton(problemId) {
  return browserList && browserList.querySelector(`[data-problem-id="${problemId}"]`);
}

function markProblemButtonSolved(problemId) {
  const button = problemButton(problemId);
  if (button) {
    button.classList.add("solved");
    button.setAttribute("aria-label", `Puzzle ${problemId}, solved`);
  }
}

function markProblemSolved(problemId) {
  if (!Number.isInteger(problemId) || problemId < 1 || problemId > TOTAL_PROBLEMS) {
    return;
  }

  const shouldWrite = !solvedProblemIds.has(problemId);
  solvedProblemIds.add(problemId);
  markProblemButtonSolved(problemId);

  if (shouldWrite) {
    writeSolvedProblemIds();
  }
}

function applySolvedProblemMarkers() {
  solvedProblemIds.forEach((problemId) => markProblemButtonSolved(problemId));
}

function legalDests() {
  const dests = new Map();
  if (!game || game.in_checkmate() || waitingForReply) {
    return dests;
  }

  game.moves({ verbose: true }).forEach((move) => {
    const existing = dests.get(move.from) || [];
    existing.push(move.to);
    dests.set(move.from, existing);
  });

  return dests;
}

function checkedKingSquare() {
  if (!game || !game.in_check()) {
    return undefined;
  }

  const checkedColor = game.turn();
  const rows = game.board();
  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < rows[row].length; col += 1) {
      const piece = rows[row][col];
      if (piece && piece.type === "k" && piece.color === checkedColor) {
        return `${FILES[col]}${8 - row}`;
      }
    }
  }

  return undefined;
}

function clearHint() {
  if (board) {
    board.setAutoShapes([]);
  }
}

function clearUserDrawings() {
  if (board) {
    board.setShapes([]);
  }
}

function clearPromotionChoice() {
  pendingPromotion = null;
  if (promotionChoiceElement) {
    promotionChoiceElement.remove();
    promotionChoiceElement = null;
  }
}

function cancelPromotionChoice() {
  if (!pendingPromotion) {
    return;
  }

  clearPromotionChoice();
  syncBoard();
}

function isPromotionMove(source, target) {
  const piece = game && game.get(source);
  return (
    piece &&
    piece.type === "p" &&
    ((piece.color === "w" && target[1] === "8") || (piece.color === "b" && target[1] === "1"))
  );
}

function showPromotionChoice(promotion) {
  clearPromotionChoice();
  pendingPromotion = promotion;

  const boardShell = document.querySelector("#board-shell");
  const overlay = document.createElement("div");
  const vertical = promotion.color === promotion.orientation ? "top" : "bottom";
  const fileIndex = FILES.indexOf(promotion.target[0]);
  let left = fileIndex * 12.5;

  if (promotion.orientation === "black") {
    left = 87.5 - left;
  }

  overlay.id = "promotion-choice";
  overlay.className = `cg-wrap ${vertical}`;
  overlay.addEventListener("click", cancelPromotionChoice);
  overlay.addEventListener("contextmenu", (event) => event.preventDefault());

  PROMOTION_OPTIONS.forEach((option, index) => {
    const square = document.createElement("square");
    const piece = document.createElement("piece");

    square.dataset.promotion = option.promotion;
    square.style.left = `${left}%`;
    square.style[vertical] = `${index * 12.5}%`;
    square.tabIndex = 0;
    square.setAttribute("role", "button");
    square.setAttribute("aria-label", `Promote to ${option.label}`);
    square.addEventListener("click", (event) => {
      event.stopPropagation();
      finishPromotion(option.promotion);
    });
    square.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " " || event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        finishPromotion(option.promotion);
      }
    });

    piece.className = `${option.role} ${promotion.color}`;
    square.appendChild(piece);
    overlay.appendChild(square);
  });

  promotionChoiceElement = overlay;
  boardShell.appendChild(overlay);
  board.set({
    movable: {
      color: null,
      dests: new Map()
    },
    selectable: {
      enabled: false
    },
    draggable: {
      enabled: false
    }
  });
}

function syncBoard(animate = true) {
  const canMove = game && !game.in_checkmate() && !waitingForReply && !pendingPromotion;

  board.set({
    fen: pieceFen(game.fen()),
    turnColor: colorName(game.turn()),
    check: checkedKingSquare(),
    lastMove: currentLastMove || undefined,
    animation: {
      enabled: animate
    },
    movable: {
      free: false,
      color: canMove ? colorName(game.turn()) : null,
      dests: canMove ? legalDests() : new Map()
    },
    selectable: {
      enabled: canMove
    },
    draggable: {
      enabled: canMove
    }
  });
}

function rejectPendingPromotion() {
  clearPromotionChoice();
  syncBoard();
}

function finishPromotion(selectedPromotion) {
  if (!pendingPromotion) {
    return;
  }

  const promotion = pendingPromotion;
  clearPromotionChoice();

  if (selectedPromotion !== promotion.expected.promotion) {
    syncBoard();
    return;
  }

  if (promotion.isFinalMove) {
    const simGame = new Chess(game.fen());
    const simMove = simGame.move({
      from: promotion.source,
      to: promotion.target,
      promotion: selectedPromotion
    });

    if (!simMove || !simGame.in_checkmate()) {
      syncBoard();
      return;
    }

    if (acceptMove(promotion.source, promotion.target, selectedPromotion) && game.in_checkmate()) {
      showSolvedState();
    } else {
      syncBoard();
    }
    return;
  }

  if (promotion.source !== promotion.expected.source || promotion.target !== promotion.expected.target) {
    syncBoard();
    return;
  }

  if (acceptMove(promotion.source, promotion.target, selectedPromotion)) {
    waitingForReply = true;
    syncBoard();
    window.setTimeout(playReplyMove, 500);
  }
}

function showSolvedState() {
  syncBoard();
  if (currentProblem) {
    markProblemSolved(currentProblem.problemid);
  }

  if (nextButton) {
    nextButton.hidden = false;
  }
}

function playReplyMove() {
  if (!correctMoves.length || game.in_checkmate()) {
    waitingForReply = false;
    if (game.in_checkmate()) {
      showSolvedState();
    } else {
      syncBoard();
    }
    return;
  }

  const { source, target, promotion } = parseMove(correctMoves[0]);
  const move = game.move({ from: source, to: target, promotion });
  waitingForReply = false;

  if (move) {
    currentLastMove = [source, target];
    correctMoves.shift();
  }

  clearHint();
  if (game.in_checkmate()) {
    showSolvedState();
  } else {
    syncBoard();
  }
}

function acceptMove(source, target, promotion) {
  const move = game.move({ from: source, to: target, promotion });
  if (!move) {
    syncBoard();
    return false;
  }

  currentLastMove = [source, target];
  correctMoves.shift();
  return true;
}

function handleMove(source, target) {
  clearHint();

  if (pendingPromotion) {
    rejectPendingPromotion();
    return;
  }

  if (waitingForReply || game.in_checkmate() || !correctMoves.length) {
    syncBoard();
    return;
  }

  const expected = parseMove(correctMoves[0]);
  const isFinalMove = correctMoves.length === 1;

  if (!isFinalMove && (source !== expected.source || target !== expected.target)) {
    syncBoard();
    return;
  }

  if (isPromotionMove(source, target)) {
    showPromotionChoice({
      source,
      target,
      expected,
      isFinalMove,
      color: colorName(game.turn()),
      orientation: board.state && board.state.orientation ? board.state.orientation : colorName(game.turn())
    });
    return;
  }

  if (isFinalMove) {
    const simGame = new Chess(game.fen());
    const simMove = simGame.move({ from: source, to: target, promotion: expected.promotion });

    if (!simMove || !simGame.in_checkmate()) {
      syncBoard();
      return;
    }

    if (acceptMove(source, target, expected.promotion) && game.in_checkmate()) {
      showSolvedState();
    } else {
      syncBoard();
    }
    return;
  }

  if (acceptMove(expected.source, expected.target, expected.promotion)) {
    waitingForReply = true;
    syncBoard();
    window.setTimeout(playReplyMove, 500);
  }
}

function showHint() {
  if (!board || pendingPromotion || waitingForReply || game.in_checkmate() || !correctMoves.length) {
    return;
  }

  const { source, target } = parseMove(correctMoves[0]);
  board.setAutoShapes([{ orig: source, dest: target, brush: "green" }]);
}

function nextProblem() {
  changeProblem(1);
}

function previousProblem() {
  changeProblem(-1);
}

function changeProblem(direction) {
  if (!currentProblem) {
    return;
  }

  const currentProblemId = currentProblem.problemid;
  if ("o" in urlParameters && currentProblemId !== (direction === 1 ? TOTAL_PROBLEMS : 1)) {
    const nextPuzzle = problems[currentProblemId - 1 + direction];
    next(nextPuzzle);
  } else if (direction === 1) {
    next();
  }
}

function sectionTitle(problem) {
  return `${problem.type} · ${problem.first}`;
}

function updateProblemMetadata(problem, replaceUrl = false) {
  document.title = `#${problem.problemid}`;

  if (activeProblemButton) {
    activeProblemButton.classList.remove("active");
    activeProblemButton.removeAttribute("aria-current");
  }

  activeProblemButton = browserList && browserList.querySelector(`[data-problem-id="${problem.problemid}"]`);
  if (activeProblemButton) {
    activeProblemButton.classList.add("active");
    activeProblemButton.setAttribute("aria-current", "true");
    activeProblemButton.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  updateProblemUrl(problem.problemid, replaceUrl);
}

function next(problem = choice(problems), animate = true, replaceUrl = false) {
  currentProblem = problem;
  currentLastMove = null;
  waitingForReply = false;
  clearPromotionChoice();
  correctMoves = problem.moves.split(";");
  game = new Chess(problem.fen);

  clearHint();
  clearUserDrawings();
  if (nextButton) {
    nextButton.hidden = true;
  }

  updateProblemMetadata(problem, replaceUrl);
  board.set({
    orientation: colorName(game.turn())
  });
  syncBoard(animate);
}

function problemFromUrl() {
  const problemId = Number(urlParameters.id);
  if (!Number.isInteger(problemId) || problemId < 1 || problemId > TOTAL_PROBLEMS) {
    return undefined;
  }

  return problems[problemId - 1];
}

function handleKeydown(event) {
  if (pendingPromotion) {
    const option = promotionOptionFromKey(event.key);
    if (option) {
      event.preventDefault();
      finishPromotion(option.promotion);
      return;
    }

    if (
      event.key === "Escape" ||
      event.key === " " ||
      event.code === "Space" ||
      event.code === "ArrowRight" ||
      event.code === "ArrowLeft"
    ) {
      event.preventDefault();
      if (event.key === "Escape") {
        cancelPromotionChoice();
      }
    }
    return;
  }

  if (isHelpOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      setHelpOpen(false);
      helpToggle.focus();
    }
    return;
  }

  if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "h") {
    event.preventDefault();
    showHint();
    return;
  }

  if (event.key === " " || event.code === "Space") {
    if (game.in_checkmate()) {
      event.preventDefault();
      nextProblem();
    }
    return;
  }

  if (event.code === "ArrowRight") {
    event.preventDefault();
    nextProblem();
    return;
  }

  if (event.code === "ArrowLeft") {
    event.preventDefault();
    previousProblem();
  }
}

function createBoard() {
  const boardElement = document.querySelector("#board");
  return Chessground(boardElement, {
    coordinates: true,
    disableContextMenu: true,
    blockTouchScroll: true,
    trustAllEvents: true,
    highlight: {
      lastMove: true,
      check: true
    },
    movable: {
      free: false,
      color: null,
      dests: new Map(),
      showDests: true,
      events: {
        after: handleMove
      }
    },
    premovable: {
      enabled: false
    },
    drawable: {
      enabled: true,
      visible: true
    }
  });
}

function renderProblemBrowser() {
  if (!browserList) {
    return;
  }

  const sections = new Map();
  problems.forEach((problem) => {
    const title = sectionTitle(problem);
    if (!sections.has(title)) {
      sections.set(title, []);
    }
    sections.get(title).push(problem);
  });

  const fragment = document.createDocumentFragment();
  sections.forEach((sectionProblems, title) => {
    const section = document.createElement("section");
    section.className = "browser-section";

    const heading = document.createElement("h2");
    heading.className = "browser-heading";
    heading.textContent = `${title} (${sectionProblems.length})`;
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "problem-grid";
    sectionProblems.forEach((problem) => {
      const button = document.createElement("button");
      button.className = "problem-link";
      button.type = "button";
      button.dataset.problemId = `${problem.problemid}`;
      button.textContent = `${problem.problemid}`;
      button.title = `${problem.type} - ${problem.first}`;
      if (solvedProblemIds.has(problem.problemid)) {
        button.classList.add("solved");
        button.setAttribute("aria-label", `Puzzle ${problem.problemid}, solved`);
      }
      grid.appendChild(button);
    });

    section.appendChild(grid);
    fragment.appendChild(section);
  });

  browserList.replaceChildren(fragment);
}

function handleBrowserClick(event) {
  const button = event.target.closest(".problem-link");
  if (!button) {
    return;
  }

  const problemId = Number(button.dataset.problemId);
  if (Number.isInteger(problemId) && problemId >= 1 && problemId <= TOTAL_PROBLEMS) {
    next(problems[problemId - 1]);
  }
}

function handlePopState(event) {
  urlParameters = getUrlParameters();
  const problemId = Number(event.state && event.state.id ? event.state.id : urlParameters.id);
  if (Number.isInteger(problemId) && problemId >= 1 && problemId <= TOTAL_PROBLEMS) {
    next(problems[problemId - 1], false, true);
  }
}

export function init() {
  appElement = document.querySelector("#app");
  nextButton = document.querySelector("#next-btn");
  problemBrowser = document.querySelector("#problem-browser");
  browserList = document.querySelector("#browser-list");
  sidebarToggle = document.querySelector("#sidebar-toggle");
  helpWidget = document.querySelector("#help-widget");
  helpToggle = document.querySelector("#help-toggle");
  helpPanel = document.querySelector("#help-panel");
  solvedProblemIds = readSolvedProblemIds();
  board = createBoard();
  renderProblemBrowser();
  applySolvedProblemMarkers();

  nextButton.addEventListener("click", nextProblem);
  browserList.addEventListener("click", handleBrowserClick);
  if (sidebarToggle && problemBrowser) {
    sidebarToggle.addEventListener("click", toggleSidebar);
    setSidebarCollapsed(readSidebarCollapsed(), false);
  }
  if (helpToggle) {
    helpToggle.addEventListener("click", toggleHelp);
    document.addEventListener("click", handleHelpDocumentClick);
  }
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("popstate", handlePopState);

  urlParameters.o = urlParameters.o || "1";
  const problem = problemFromUrl() || problems[0];
  next(problem, true, true);
}
