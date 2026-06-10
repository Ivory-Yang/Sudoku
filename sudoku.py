import random

DIFFICULTY_CLUES = {
    "easy": 40,
    "medium": 32,
    "hard": 26,
    "expert": 22,
}


def find_empty(grid):
    for r in range(9):
        for c in range(9):
            if grid[r][c] == 0:
                return r, c
    return None


def is_valid(grid, row, col, num):
    if any(grid[row][c] == num for c in range(9)):
        return False
    if any(grid[r][col] == num for r in range(9)):
        return False
    br, bc = row - row % 3, col - col % 3
    for r in range(br, br + 3):
        for c in range(bc, bc + 3):
            if grid[r][c] == num:
                return False
    return True


def solve(grid):
    pos = find_empty(grid)
    if pos is None:
        return True
    row, col = pos
    for num in range(1, 10):
        if is_valid(grid, row, col, num):
            grid[row][col] = num
            if solve(grid):
                return True
            grid[row][col] = 0
    return False


def count_solutions(grid, limit=2):
    # MRV: branch on the cell with the fewest candidates
    best = None
    best_cands = None
    for r in range(9):
        for c in range(9):
            if grid[r][c] == 0:
                cands = [n for n in range(1, 10) if is_valid(grid, r, c, n)]
                if not cands:
                    return 0
                if best_cands is None or len(cands) < len(best_cands):
                    best, best_cands = (r, c), cands
                    if len(cands) == 1:
                        break
        else:
            continue
        break
    if best is None:
        return 1
    row, col = best
    count = 0
    for num in best_cands:
        grid[row][col] = num
        count += count_solutions(grid, limit - count)
        grid[row][col] = 0
        if count >= limit:
            break
    return count


def generate_full_grid():
    grid = [[0] * 9 for _ in range(9)]

    def fill(pos=0):
        if pos == 81:
            return True
        row, col = divmod(pos, 9)
        nums = list(range(1, 10))
        random.shuffle(nums)
        for num in nums:
            if is_valid(grid, row, col, num):
                grid[row][col] = num
                if fill(pos + 1):
                    return True
                grid[row][col] = 0
        return False

    fill()
    return grid


def generate_puzzle(difficulty="medium"):
    """Returns (puzzle, solution). Puzzle cells with 0 are empty."""
    clues = DIFFICULTY_CLUES.get(difficulty, DIFFICULTY_CLUES["medium"])
    solution = generate_full_grid()
    puzzle = [row[:] for row in solution]

    cells = [(r, c) for r in range(9) for c in range(9)]
    random.shuffle(cells)
    remaining = 81

    for r, c in cells:
        if remaining <= clues:
            break
        backup = puzzle[r][c]
        puzzle[r][c] = 0
        test = [row[:] for row in puzzle]
        if count_solutions(test) != 1:
            puzzle[r][c] = backup
        else:
            remaining -= 1

    return puzzle, solution


def check_board(puzzle, solution, current):
    """Compare current board against the solution.

    Returns dict with:
      wrong: cells filled but not matching the solution
      conflicts: cells violating row/col/box rules
      complete: True if every cell matches the solution
    """
    wrong = []
    conflicts = set()
    complete = True

    for r in range(9):
        for c in range(9):
            val = current[r][c]
            if val == 0:
                complete = False
                continue
            if val != solution[r][c]:
                wrong.append([r, c])
                complete = False

    def add_conflicts(cells):
        seen = {}
        for r, c in cells:
            val = current[r][c]
            if val == 0:
                continue
            if val in seen:
                conflicts.add((r, c))
                conflicts.add(seen[val])
            else:
                seen[val] = (r, c)

    for i in range(9):
        add_conflicts([(i, c) for c in range(9)])
        add_conflicts([(r, i) for r in range(9)])
    for br in range(0, 9, 3):
        for bc in range(0, 9, 3):
            add_conflicts([(br + r, bc + c) for r in range(3) for c in range(3)])

    return {
        "wrong": wrong,
        "conflicts": [list(cell) for cell in sorted(conflicts)],
        "complete": complete,
    }


def progress(puzzle, solution, current):
    """Fraction of originally-empty cells filled correctly (0.0 - 1.0)."""
    total = correct = 0
    for r in range(9):
        for c in range(9):
            if puzzle[r][c] == 0:
                total += 1
                if current[r][c] == solution[r][c]:
                    correct += 1
    return correct / total if total else 1.0
