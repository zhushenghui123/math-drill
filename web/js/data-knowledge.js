/* 考研数学知识树：高等数学 / 线性代数 / 概率论与数理统计
 * node.exam: 'all' 表示数一数二数三公共；数组表示仅指定范围
 * content 为教学正文（Markdown + LaTeX，\\ 为转义后的反斜杠）
 */
window.KDATA = {
  categories: [
    {
      id: 'calculus', name: '高等数学', color: '#1b4d8f',
      chapters: [
        {
          name: '第一章 函数、极限与连续', nodes: [
            { id: 'c1n1', title: '数列极限的定义', difficulty: 3, exam: 'all',
              content: '若存在常数 A，使得对任意 \\varepsilon > 0，总存在正整数 N，当 n > N 时恒有 |x_n - A| < \\varepsilon，则称数列 \\{x_n\\} 以 A 为极限。\n\n考试上常用的工具是夹逼准则与单调有界准则：夹逼适用于能放缩的式子；单调有界适用于递推式 x_{n+1} = f(x_n)。',
              example: '求 \\lim_{n \\to \\infty} \\frac{n}{n+1}：由 |\\frac{n}{n+1} - 1| = \\frac{1}{n+1} < \\varepsilon 取 N > \\frac{1}{\\varepsilon} - 1 即证，直观上分子分母同阶，极限为 1。',
              related: ['c1n2', 'c1n3'] },
            { id: 'c1n2', title: '两个重要极限（一）', difficulty: 3, exam: 'all',
              content: '第一个重要极限：\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1。\n\n变形用法：\\lim_{x \\to 0} \\frac{\\sin ax}{bx} = \\frac{a}{b}；若分子是 \\sin(\\square) 且 \\square \\to 0，可将式子配成 \\frac{\\sin \\square}{\\square} 的形式。注意它只能用于 x \\to 0 的情形',
              example: '求 \\lim_{x \\to 0} \\frac{\\sin 3x}{2x} = \\lim_{x \\to 0} \\frac{3}{2} \\cdot \\frac{\\sin 3x}{3x} = \\frac{3}{2}。',
              related: ['c1n1', 'c1n3'] },
            { id: 'c1n3', title: '两个重要极限（二）', difficulty: 3, exam: 'all',
              content: '第二个重要极限：\\lim_{x \\to \\infty} (1 + \\frac{1}{x})^{x} = e，等价形式 \\lim_{x \\to 0} (1 + x)^{\\frac{1}{x}} = e。\n\n推广：\\lim (1 + u)^{\\frac{1}{u}} = e（u \\to 0）。处理 1^{\\infty} 型未定式的通法是取对数化为 \\lim u \\cdot \\ln(1+v)。',
              example: '求 \\lim_{n \\to \\infty} (1 + \\frac{2}{n})^{n} = \\lim (1 + \\frac{2}{n})^{\\frac{n}{2} \\cdot 2} = e^{2}。',
              related: ['c1n2', 'c1n4'] },
            { id: 'c1n4', title: '无穷小与等价代换', difficulty: 2, exam: 'all',
              content: '当 x \\to 0 时常用等价无穷小：\\sin x \\sim x，\\tan x \\sim x，1 - \\cos x \\sim \\frac{x^{2}}{2}，\\ln(1+x) \\sim x，e^{x} - 1 \\sim x，\\arcsin x \\sim x，(1+x)^{\\alpha} - 1 \\sim \\alpha x。\n\n等价代换只能用于乘除因子，加减中慎用（除非你能证明两者不同阶抵消后仍等价）。',
              example: '求 \\lim_{x \\to 0} \\frac{1 - \\cos x}{x^{2}}：分子等价于 \\frac{x^{2}}{2}，故极限为 \\frac{1}{2}。',
              related: ['c1n3'] },
            { id: 'c1n5', title: '函数的连续与间断', difficulty: 2, exam: 'all',
              content: 'f(x) 在 x_0 连续 \\Leftrightarrow \\lim_{x \\to x_0} f(x) = f(x_0)，即"极限存在 + 等于函数值"两个条件同时成立。\n\n间断点分类：极限不存在（跳、无穷、振荡）为第一/第二类核心判据——左右极限都存在的间断点叫第一类（可去/跳跃），否则叫第二类（无穷/振荡）。',
              example: 'f(x) = \\frac{x^{2} - 1}{x - 1} 在 x = 1 处无定义但 \\lim_{x \\to 1} f(x) = 2，属于可去间断点（第一类）。',
              related: ['c1n6'] },
            { id: 'c1n6', title: '闭区间上连续函数的性质', difficulty: 2, exam: 'all',
              content: '闭区间 [a,b] 上连续的函数必：① 有界且能取到最大最小值（最值定理）；② 取到介于 f(a)、f(b) 之间的一切值（介值定理）；③ 若 f(a)f(b) < 0，则存在 \\xi \\in (a,b) 使 f(\\xi) = 0（零点定理）。',
              example: '证明方程 x^{3} + x - 1 = 0 在 (0,1) 内有根：f(0) = -1 < 0，f(1) = 1 > 0，由零点定理即得。',
              related: ['c1n5', 'c3n1'] }
          ]
        },
        {
          name: '第二章 一元函数微分学', nodes: [
            { id: 'c2n1', title: '导数的定义', difficulty: 3, exam: 'all',
              content: 'f\'(x_0) = \\lim_{\\Delta x \\to 0} \\frac{f(x_0 + \\Delta x) - f(x_0)}{\\Delta x}。\n\n判可导的充要条件：左右导数存在且相等。可导必连续，连续不一定可导（如 |x| 在 0 处）。分段函数在分段点的可导性必须用定义判断。',
              example: 'f(x) = |x| 在 x = 0：右导数 = 1，左导数 = -1，左右不等，故不可导。',
              related: ['c2n2', 'c2n3'] },
            { id: 'c2n2', title: '求导法则与高阶导数', difficulty: 2, exam: 'all',
              content: '四则法则、复合函数链式法则、反函数、隐函数、参数方程求导均要熟练。\n\n高阶导数的两大考点：莱布尼茨公式（两函数乘积的 n 阶导，形似二项展开）与常见函数 n 阶导公式：e^{x}、(1+x)^{-1}、\\ln(1+x)、\\sin x、\\cos x。',
              example: '(\\sin x)^{(n)} = \\sin(x + \\frac{n\\pi}{2})；特别的 n = 2 时 (\\sin x)\'\' = -\\sin x。',
              related: ['c2n1', 'c3n1'] },
            { id: 'c2n3', title: '罗尔定理', difficulty: 3, exam: 'all',
              content: '若 f(x) 在 [a,b] 连续、在 (a,b) 可导，且 f(a) = f(b)，则存在 \\xi \\in (a,b) 使 f\'(\\xi) = 0。\n\n证明"存在一点导数为零"或"方程有根"的通用套路：构造辅助函数 F(x) 满足 F(a) = F(b)，再对 F 用罗尔定理。',
              example: '证明 f(x) = x^{3} - 3x 在 [-1, 1] 上存在 \\xi 使 f\'(\\xi) = 0：f(-1) = f(1) = -2，直接由罗尔定理得到。',
              related: ['c2n4', 'c3n1'] },
            { id: 'c2n4', title: '拉格朗日与柯西中值定理', difficulty: 3, exam: 'all',
              content: '拉格朗日：存在 \\xi 使 f(b) - f(a) = f\'(\\xi)(b - a)，推论"导数恒为 0 则函数恒为常数"。\n\n柯西：\\frac{f(b) - f(a)}{g(b) - g(a)} = \\frac{f\'(\\xi)}{g\'(\\xi)}，是洛必达法则与很多不等式证明的理论基础。\n\n考法：证明含 f\'(\\xi) 的等式或不等式时构造目标函数用中值定理。',
              example: '证明 \\arctan b - \\arctan a 有界：由拉格朗日，它等于 \\frac{1}{1 + \\xi^{2}}(b - a)，且 \\frac{1}{1+\\xi^{2}} \\le 1，故 |\\arctan b - \\arctan a| \\le |b - a|。',
              related: ['c2n3', 'c2n5'] },
            { id: 'c2n5', title: '洛必达法则', difficulty: 2, exam: 'all',
              content: '对 \\frac{0}{0} 或 \\frac{\\infty}{\\infty} 型未定式，\\lim \\frac{f(x)}{g(x)} = \\lim \\frac{f\'(x)}{g\'(x)}（若后者极限存在）。\n\n使用前提：① 分子分母分别可导；② 代入后确实为未定式；③ 求导后的极限存在或为无穷大。其它型（0 \\cdot \\infty、\\infty - \\infty、1^{\\infty}）先变形再洛必达。',
              example: '求 \\lim_{x \\to 0} \\frac{e^{x} - 1 - x}{x^{2}}：两次洛必达得 \\lim_{x \\to 0} \\frac{e^{x}}{2} = \\frac{1}{2}。',
              related: ['c2n4', 'c1n4'] },
            { id: 'c2n6', title: '泰勒公式', difficulty: 4, exam: 'all',
              content: 'f(x) = f(x_0) + f\'(x_0)(x - x_0) + \\frac{f\'\'(x_0)}{2!}(x - x_0)^{2} + \\cdots + \\frac{f^{(n)}(x_0)}{n!}(x - x_0)^{n} + R_n(x)。\n\n必背五个在 0 点的展开：e^{x}、\\sin x、\\cos x、\\ln(1+x)、(1+x)^{\\alpha}。\n\n考法：求极限（精确到和分母同阶）、证明高阶不等式、求 n 阶导数。',
              example: 'e^{x} = 1 + x + \\frac{x^{2}}{2!} + \\frac{x^{3}}{3!} + o(x^{3})，用它可快速求含 e^{x} 复杂极限。',
              related: ['c2n5', 'c1n4'] },
            { id: 'c2n7', title: '单调性与极值、凹凸与拐点', difficulty: 2, exam: 'all',
              content: 'f\'(x) > 0 则单增、< 0 则单减；极值点判断：一阶导变号（第一充分条件）或 f\'\'(x_0) \\ne 0 与 f\'(x_0) = 0（第二充分条件，f\'\' > 0 取极小）。\n\n凹凸性：f\'\'(x) > 0 凹（开口向上），曲线凹凸性改变的点（f\'\' 变号且连续）为拐点。',
              example: 'f(x) = x^{3}：f\'(x) = 3x^{2} \\ge 0 不严格单增判定要用 f\'\'；拐点在 x = 0（f\'\' = 6x 变号）。',
              related: ['c2n6', 'c3n5'] }
          ]
        },
        {
          name: '第三章 一元函数积分学', nodes: [
            { id: 'c3n1', title: '不定积分基本公式', difficulty: 2, exam: 'all',
              content: '必须背熟：\\int x^{a}dx = \\frac{x^{a+1}}{a+1} + C，\\int \\frac{1}{x}dx = \\ln|x| + C，\\int e^{x}dx = e^{x} + C，\\int \\sin x \\, dx = -\\cos x + C，\\int \\sec^{2}x \\, dx = \\tan x + C，\\int \\frac{1}{1+x^{2}}dx = \\arctan x + C，\\int \\frac{1}{\\sqrt{1-x^{2}}}dx = \\arcsin x + C。\n\n不定积分结果必加任意常数 C；可对结果求导回验。',
              example: '\\int (3x^{2} + \\frac{1}{x})dx = x^{3} + \\ln|x| + C。',
              related: ['c3n2', 'c3n3'] },
            { id: 'c3n2', title: '换元积分法', difficulty: 3, exam: 'all',
              content: '第一类换元（凑微分）：\\int f(g(x))g\'(x)dx，令 u = g(x)。\n\n第二类换元：三角代换 \\sqrt{a^{2} - x^{2}} 令 x = a\\sin t，\\sqrt{x^{2} + a^{2}} 令 x = a\\tan t，\\sqrt{x^{2} - a^{2}} 令 x = a\\sec t；无理根式代换 t = \\sqrt[n]{ax + b}。',
              example: '\\int \\frac{1}{1 + x^{2}} \\cdot 2x \\, dx：凑 \\int \\frac{d(x^{2})}{1+x^{2}} = \\ln(1+x^{2}) + C。',
              related: ['c3n1', 'c3n3'] },
            { id: 'c3n3', title: '分部积分法', difficulty: 3, exam: 'all',
              content: '\\int u \\, dv = uv - \\int v \\, du。\n\n选 u 的优先级口诀"反对幂指三"：反三角函数、对数、幂函数、指数、三角函数——越靠前的越先当 u。典型组合：\\int x \\ln x \\, dx、\\int x e^{x} dx、\\int e^{x} \\sin x \\, dx（后一个会"循环，解方程"。',
              example: '\\int x e^{x} dx = x e^{x} - \\int e^{x} dx = (x - 1)e^{x} + C。',
              related: ['c3n2'] },
            { id: 'c3n4', title: '定积分的定义与性质', difficulty: 2, exam: 'all',
              content: '\\int_a^b f(x)dx \\approx \\lim_{n \\to \\infty} \\sum_{i=1}^{n} f(\\xi_i)\\Delta x_i，几何意义是曲边梯形面积（有正负）。\n\n核心性质：线性、可加性（拆区间）、\\int_a^b 与 \\int_b^a 反号、估值定理（m(b-a) \\le \\int_a^b f \\le M(b-a)）、奇偶性（奇零偶倍）。',
              example: 'f(x) 为 [-a,a] 上奇函数，则 \\int_{-a}^{a} f(x)dx = 0。',
              related: ['c3n5', 'c3n1'] },
            { id: 'c3n5', title: '变限积分函数', difficulty: 3, exam: 'all',
              content: 'F(x) = \\int_{a}^{x} f(t)dt，则 F\'(x) = f(x)；若上下限都是函数：\\frac{d}{dx}\\int_{\\varphi(x)}^{\\psi(x)} f(t)dt = f(\\psi(x))\\psi\'(x) - f(\\varphi(x))\\varphi\'(x)。\n\n高频考法：含变限积分的极限（洛必达/泰勒）、变限积分函数求导、讨论其单调性与极值。',
              example: '\\frac{d}{dx} \\int_{0}^{x^{2}} \\sin t \\, dt = \\sin(x^{2}) \\cdot 2x = 2x\\sin(x^{2})。',
              related: ['c3n4', 'c2n5'] },
            { id: 'c3n6', title: '反常积分', difficulty: 3, exam: 'all',
              content: '两类：无穷限 \\int_a^{+\\infty} f(x)dx 与瑕积分（被积函数在瑕点无界，如 \\int_0^1 \\frac{1}{x^{p}} dx）。\n\n两个参考标准：\\int_1^{+\\infty} \\frac{1}{x^{p}} dx 收敛 \\Leftrightarrow p > 1；\\int_0^1 \\frac{1}{x^{p}} dx 收敛 \\Leftrightarrow p < 1。\n\n判敛常用比较法、极限比较法、等价无穷小。',
              example: '\\int_1^{+\\infty} \\frac{1}{x^{2}} dx = [-\\frac{1}{x}]_1^{+\\infty} = 1，收敛。',
              related: ['c3n4', 'c1n4'] },
            { id: 'c3n7', title: '定积分的应用', difficulty: 3, exam: 'all',
              content: '面积：A = \\int_a^b |f(x) - g(x)|dx 或极坐标 \\frac{1}{2}\\int_{\\alpha}^{\\beta} r^{2}(\\theta)d\\theta。\n\n旋转体体积：绕 x 轴 V = \\pi\\int_a^b f^{2}(x)dx；绕 y 轴用壳层法 V = 2\\pi\\int_a^b x f(x)dx。弧长、侧面积也是常规考点。',
              example: '圆盘 x^{2} + y^{2} \\le R^{2} 绕 x 轴：V = \\pi\\int_{-R}^{R} (R^{2} - x^{2})dx = \\frac{4}{3}\\pi R^{3}。',
              related: ['c3n4'] }
          ]
        },
        {
          name: '第四章 多元函数微分学', nodes: [
            { id: 'c4n1', title: '偏导数与全微分', difficulty: 3, exam: 'all',
              content: '偏导数 f_x(x_0,y_0) = \\lim_{\\Delta x \\to 0} \\frac{f(x_0+\\Delta x, y_0) - f(x_0,y_0)}{\\Delta x}（把 y 当常数）。\n\n可微的定义：\\Delta z = f_x \\Delta x + f_y \\Delta y + o(\\rho)，其中 \\rho = \\sqrt{(\\Delta x)^{2} + (\\Delta y)^{2}}。\n\n结论链：可微 \\Rightarrow 连续、可微 \\Rightarrow 偏导存在；反之均不然。判断分段函数在原点是否可微：算偏导后验证 \\frac{\\Delta z - f_x\\Delta x - f_y\\Delta y}{\\rho} \\to 0。',
              example: 'f(x,y) = e^{xy}，则 f_x = ye^{xy}，f_y = xe^{xy}。',
              related: ['c4n2'] },
            { id: 'c4n2', title: '多元复合函数求导（链式法则）', difficulty: 3, exam: 'all',
              content: 'z = f(u,v)，u = u(x,y)，v = v(x,y)，则 \\frac{\\partial z}{\\partial x} = \\frac{\\partial z}{\\partial u}\\frac{\\partial u}{\\partial x} + \\frac{\\partial z}{\\partial v}\\frac{\\partial v}{\\partial x}（路径图：画树形图数清每条路径，逐路相乘、分路相加）。\n\n隐函数求导：F(x,y) = 0 时 \\frac{dy}{dx} = -\\frac{F_x}{F_y}；三元隐函数 F(x,y,z) = 0 类似。',
              example: 'z = \\sin(xy)，令 u = xy，则 z_x = \\cos(xy) \\cdot y。',
              related: ['c4n1'] },
            { id: 'c4n3', title: '多元函数极值与最值', difficulty: 3, exam: 'all',
              content: '无条件极值（驻点判别法）：求解 f_x = f_y = 0 得到驻点，令 A = f_{xx}，B = f_{xy}，C = f_{yy}，判别式 AC - B^{2}：> 0 且 A > 0 取极小、A < 0 取极大；< 0 非极值；= 0 需另判。\n\n条件极值：拉格朗日乘数法——目标函数 f(x,y) 约束 \\varphi(x,y) = 0，构造 L = f + \\lambda\\varphi 后解方程组。',
              example: '长方体最大体积问题（约束表面积）是条件极值经典题，用拉格朗日乘数法得正方体最优。',
              related: ['c4n1', 'c2n7'] },
            { id: 'c4n4', title: '方向导数与梯度', difficulty: 3, exam: 'all',
              content: '方向导数 \\frac{\\partial f}{\\partial l} = f_x \\cos\\alpha + f_y \\cos\\beta + f_z \\cos\\gamma，其中 (\\cos\\alpha, \\cos\\beta, \\cos\\gamma) 是方向 l 的单位向量。\n\n梯度 grad f = (f_x, f_y, f_z) 是方向导数最大的方向，其模长 = 最大方向导数。',
              example: 'f = x^{2} + y^{2} 在 (1,1) 处梯度为 (2,2)，沿该方向上升最快。',
              related: ['c4n1', 'c4n3'] }
          ]
        },
        {
          name: '第五章 重积分', nodes: [
            { id: 'c5n1', title: '二重积分的概念与性质', difficulty: 2, exam: 'all',
              content: '\\iint_D f(x,y)dxdy 是曲顶柱体体积。性质：线性、可加性、比较大小（被积函数大的积分大）、估值定理、奇偶性对称性（关于 x 轴对称且被积函数关于 y 为奇函数则积分为 0，偶函数取半倍）。\n\n利用对称性化简是选择题高频考点。',
              example: 'D 关于原点对称，f 为奇函数，则 \\iint_D f = 0。',
              related: ['c5n2', 'c3n4'] },
            { id: 'c5n2', title: '二重积分的计算', difficulty: 3, exam: 'all',
              content: '直角坐标：先定 X 型（先 y 后 x）还是 Y 型（先 x 后 y），原则是让内层积分的上下限尽量简单。\n\n极坐标：圆心在原点或被积函数含 x^{2} + y^{2} 时用 \\iint f(r\\cos\\theta, r\\sin\\theta) \\, r \\, drd\\theta，注意多乘因子 r（雅可比行列式）。',
              example: '\\iint_{x^{2}+y^{2}\\le R^{2}} e^{x^{2}+y^{2}} dxdy = \\int_0^{2\\pi} \\int_0^R e^{r^{2}} r \\, dr d\\theta = \\pi(e^{R^{2}} - 1)。',
              related: ['c5n1'] },
            { id: 'c5n3', title: '三重积分', difficulty: 3, exam: ['m1'],
              content: '直角坐标（先一后二 / 先二后一）、柱坐标（被积函数含 x^{2}+y^{2}，r 因子同二重）、球坐标（区域为球体，dv = \\rho^{2} \\sin\\varphi \\, d\\rho d\\varphi d\\theta）。\n\n重点题型：求立体体积、均匀立体质心与转动惯量。',
              example: '球体半径 R 的体积 \\iiint dv = \\int_0^{2\\pi}\\int_0^{\\pi}\\int_0^R \\rho^{2}\\sin\\varphi \\, d\\rho d\\varphi d\\theta = \\frac{4}{3}\\pi R^{3}。',
              related: ['c5n2'] },
            { id: 'c5n4', title: '曲线曲面积分', difficulty: 4, exam: ['m1'],
              content: '第一类（对弧长/面积，与方向无关）：\\int_L f ds、\\iint_{\\Sigma} f dS，物理意义是质量。\n\n第二类（对坐标，与方向有关）：\\int_L P dx + Q dy、\\iint_{\\Sigma} P dy dz + Q dz dx + R dx dy。求解第二类积分的三大最强工具：格林公式（平面闭曲线）、高斯公式（空间闭曲面，div 散度）、斯托克斯公式（空间闭曲线，旋度）。',
              example: '格林公式：\\oint_L Pdx + Qdy = \\iint_D (Q_x - P_y)dxdy（L 为 D 的正向边界），常用来把封闭曲线积分化为二重积分。',
              related: ['c5n3', 'c1n6'] }
          ]
        },
        {
          name: '第六章 无穷级数', nodes: [
            { id: 'c6n1', title: '常数项级数的敛散性', difficulty: 3, exam: ['m1', 'm3'],
              content: '必备结论：\\sum_{n=1}^{\\infty} \\frac{1}{n^{p}} 收敛 \\Leftrightarrow p > 1（p-级数）；\\sum q^{n} 收敛 \\Leftrightarrow |q| < 1（等比）。\n\n判敛法：正项级数用比较、比值（\\lim \\frac{a_{n+1}}{a_n} = \\rho，> 1 发散 < 1 收敛）、根值；任意项级数先看绝对收敛/条件收敛（莱布尼茨判别法用于交错级数）。\n\n必要条件：\\lim a_n \\ne 0 必发散。',
              example: '\\sum \\frac{n}{n^{2}+1}：与 \\frac{1}{n} 同阶，发散（p=1 级数发散）。',
              related: ['c6n2', 'c1n1'] },
            { id: 'c6n2', title: '幂级数与和函数', difficulty: 4, exam: ['m1', 'm3'],
              content: '收敛半径 R：R = \\lim |\\frac{a_n}{a_{n+1}}|（比值法求系数比）。幂级数在收敛区间内可逐项求导、逐项积分，和函数通过这两招化归为 \\frac{1}{1-x} 型（几何级数）或利用已知展开式反推。\n\n常用：\\sum_{n=0}^{\\infty} x^{n} = \\frac{1}{1-x}（|x| < 1），逐项积分得 \\sum \\frac{x^{n}}{n} = -\\ln(1-x)。',
              example: '\\sum_{n=0}^{\\infty} n x^{n} = x(\\sum x^{n})\' = \\frac{x}{(1-x)^{2}}，|x| < 1。',
              related: ['c6n1', 'c6n3'] },
            { id: 'c6n3', title: '傅里叶级数', difficulty: 4, exam: ['m1'],
              content: '周期为 2\\pi 的函数 f(x) 的傅里叶系数：a_n = \\frac{1}{\\pi}\\int_{-\\pi}^{\\pi} f(x)\\cos nx \\, dx，b_n = \\frac{1}{\\pi}\\int_{-\\pi}^{\\pi} f(x)\\sin nx \\, dx，级数 \\frac{a_0}{2} + \\sum(a_n \\cos nx + b_n \\sin nx)。\n\n收敛定理（狄利克雷）：在连续点收敛于 f(x)；在间断点收敛于左右极限平均值。奇函数只有正弦项，偶函数只有余弦项。',
              example: '(' + '奇函数展开只有 b_n 项（正弦级数），这是判断展开式形式的第一道关卡' + ')。',
              related: ['c6n2'] }
          ]
        },
        {
          name: '第七章 微分方程', nodes: [
            { id: 'c7n1', title: '一阶微分方程', difficulty: 3, exam: 'all',
              content: '四类解法必须熟练：① 可分离变量：g(y)dy = f(x)dx 两边积分；② 齐次方程：令 u = \\frac{y}{x}；③ 一阶线性：y\' + P(x)y = Q(x)，通解 y = e^{-\\int P dx}(\\int Q e^{\\int P dx}dx + C)；④ 伯努利：令 z = y^{1-n} 化线性。',
              example: '解 y\' = 2xy：分离变量得 \\frac{dy}{y} = 2x dx，\\ln|y| = x^{2} + C，y = Ce^{x^{2}}。',
              related: ['c7n2'] },
            { id: 'c7n2', title: '二阶常系数线性微分方程', difficulty: 3, exam: 'all',
              content: '齐次 y\'\' + py\' + qy = 0：特征方程 r^{2} + pr + q = 0，两个不等实根 y = C_1 e^{r_1 x} + C_2 e^{r_2 x}，重根 y = (C_1 + C_2 x)e^{rx}，共轭复根 \\alpha \\pm \\beta i 则 y = e^{\\alpha x}(C_1 \\cos\\beta x + C_2 \\sin\\beta x)。\n\n非齐次 f(x) = e^{\\lambda x}P_m(x) 时设特解 y^{*} = x^{k} e^{\\lambda x} Q_m(x)，其中 k 按 \\lambda 是否为特征根取 0/1/2（单根/重根）。',
              example: 'y\'\' - y = 0：特征根 r = \\pm 1，通解 y = C_1 e^{x} + C_2 e^{-x}。',
              related: ['c7n1'] },
            { id: 'c7n3', title: '可降阶的高阶方程与全微分方程', difficulty: 3, exam: ['m1', 'm3'],
              content: '可直接降阶：y\'\' = f(x) 连积两次；不含 y 的 y\'\' = f(x, y\') 令 p = y\'；不含 x 的 y\'\' = f(y, y\') 令 p = \\frac{dy}{dx}，y\'\' = p\\frac{dp}{dy}。\n\n全微分方程：P dx + Q dy = 0 若 \\frac{\\partial P}{\\partial y} = \\frac{\\partial Q}{\\partial x}，则存在原函数 u 使 du = Pdx + Qdy，通解 u = C。',
              example: '(2xy + 1)dx + x^{2}dy = 0：检查 \\frac{\\partial P}{\\partial y} = 2x = \\frac{\\partial Q}{\\partial x}，原函数 u = x^{2}y + x，通解 x^{2}y + x = C。',
              related: ['c7n1', 'c7n2'] }
          ]
        }
      ]
    },
    {
      id: 'linear', name: '线性代数', color: '#2f6b4f',
      chapters: [
        {
          name: '第八章 行列式', nodes: [
            { id: 'l1n1', title: '行列式的性质与计算', difficulty: 2, exam: 'all',
              content: '关键性质：转置值不变；两行互换变号；某行乘 k 值乘 k；两行成比例值为 0；某行加另一行 k 倍值不变。\n\n计算套路：先用行变换化成上三角，或按"含 0 最多/含 1 的行列"展开降阶。分块行列式：\\begin{vmatrix} A & 0 \\\\ 0 & B \\end{vmatrix} = |A||B|。',
              example: '二阶行列式 \\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix} = ad - bc，如 \\begin{vmatrix} 1 & 2 \\\\ 3 & 4 \\end{vmatrix} = -2。',
              related: ['l1n2', 'l2n3'] },
            { id: 'l1n2', title: '行列式按行（列）展开', difficulty: 3, exam: 'all',
              content: '余子式 M_{ij} 去掉第 i 行第 j 列；代数余子式 A_{ij} = (-1)^{i+j}M_{ij}。\n\n展开定理：某行元素乘以该行代数余子式之和 = |A|；乘以异行代数余子式之和 = 0（"错位相消"）。这个"异行为 0"性质是计算伴随矩阵、讨论 A^{*} 题型的关键。',
              example: '对 3 阶矩阵，按第 1 行展开：|A| = a_{11}A_{11} + a_{12}A_{12} + a_{13}A_{13}。',
              related: ['l1n1', 'l2n2'] },
            { id: 'l1n3', title: '克拉默法则', difficulty: 2, exam: 'all',
              content: 'n 元线性方程组 Ax = b，若 |A| \\ne 0，则方程组有唯一解 x_i = \\frac{|A_i|}{|A|}，其中 A_i 是把第 i 列换成 b 得到的矩阵。\n\n推论：齐次方程组 Ax = 0 有非零解 \\Leftrightarrow |A| = 0（这是判断齐次方程有无非零解的最快工具）。',
              example: '齐次方程组 [[1,1],[1,1]]x = 0：|A| = 0，有非零解（如 (1,-1)）。',
              related: ['l1n1', 'l4n1'] }
          ]
        },
        {
          name: '第九章 矩阵', nodes: [
            { id: 'l2n1', title: '矩阵的运算', difficulty: 2, exam: 'all',
              content: '矩阵乘法不满足交换律和消去律：AB \\ne BA 一般成立；AB = 0 推不出 A = 0 或 B = 0。\n\n常用公式：|kA| = k^{n}|A|（n 阶）；(AB)^{T} = B^{T}A^{T}；(AB)^{-1} = B^{-1}A^{-1}；(AB)^{*} = B^{*}A^{*}。\n\n转置、逆、伴随的"穿脱"规则是考试必考。',
              example: '(AB)^{-1} = B^{-1}A^{-1}，注意顺序要反过来。',
              related: ['l2n2', 'l2n3'] },
            { id: 'l2n2', title: '逆矩阵', difficulty: 3, exam: 'all',
              content: 'A 可逆 \\Leftrightarrow |A| \\ne 0 \\Leftrightarrow r(A) = n \\Leftrightarrow A 的列（行）向量组线性无关。\n\n求逆方法：① 伴随矩阵法 A^{-1} = \\frac{1}{|A|}A^{*}；② 初等行变换法 (A|E) \\to (E|A^{-1})——实际考试首选。\n\n核心公式：A A^{*} = A^{*}A = |A|E，由此得 |A^{*}| = |A|^{n-1}，(A^{*})^{*} = |A|^{n-2}A。',
              example: 'A = \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} 且 ad - bc \\ne 0，则 A^{-1} = \\frac{1}{ad-bc}\\begin{bmatrix} d & -b \\\\ -c & a \\end{bmatrix}。',
              related: ['l1n2', 'l2n1'] },
            { id: 'l2n3', title: '矩阵的秩', difficulty: 3, exam: 'all',
              content: '秩 r(A) = 非零子式的最高阶数；用初等行变换化成行阶梯形，非零行数即秩。\n\n常用结论：r(A) \\le \\min(m,n)；r(AB) \\le \\min(r(A), r(B))；r(A) + r(B) - n \\le r(AB) \\le r(A) + r(B)；r(A) = r(A^{T})；r(kA) = r(A)（k \\ne 0）。\n\n最值不等式题（r(A)+r(B) 的范围）是高频压轴小题。',
              example: 'A 为 3 阶非零矩阵且 A^{2} = 0，则 r(A) \\le 1（由 r(A) + r(A) - 3 \\le r(A^{2}) = 0）。',
              related: ['l2n1', 'l3n2'] }
          ]
        },
        {
          name: '第十章 向量组', nodes: [
            { id: 'l3n1', title: '线性相关与线性表示', difficulty: 3, exam: 'all',
              content: '定义：存在不全为零的 k_i 使 \\sum k_i \\alpha_i = 0，则向量组线性相关（否则无关）。\n\n判定：向量组所含向量个数 > 维数必相关；含零向量必相关；部分相关则整体相关。\n\n"能由 \\alpha_1,...,\\alpha_s 线性表示" \\Leftrightarrow 增广矩阵的秩 r(\\alpha_1,...,\\alpha_s, \\beta) = r(\\alpha_1,...,\\alpha_s)。',
              example: '(1,0)、(0,1) 线性无关；(1,2)、(2,4) 线性相关（2 倍关系）。',
              related: ['l3n2', 'l4n1'] },
            { id: 'l3n2', title: '极大无关组与向量组的秩', difficulty: 3, exam: 'all',
              content: '极大线性无关组：能表示全组且自身线性无关的部分组。向量组的秩 = 极大无关组所含向量个数 = r(矩阵)（列向量组的秩等于矩阵的秩）。\n\n求极大无关组：向量按列排成矩阵做初等行变换，阶梯形主元列对应原向量即构成极大无关组。',
              example: '向量组 (1,1),(2,2),(0,1)：极大无关组可取 {(1,1),(0,1)}，秩为 2。',
              related: ['l3n1', 'l2n3'] },
            { id: 'l3n3', title: '向量空间与基变换', difficulty: 3, exam: ['m1'],
              content: 'n 维向量空间的基 = 极大无关组，维数 = 秩。坐标：向量在基下的表示系数。\n\n基变换公式：由旧基到新基的过渡矩阵 P 满足 (新基) = (旧基)P；坐标变换 x = P y（新坐标 y = P^{-1}x）。',
              example: 'R^{2} 的标准基 e_1=(1,0), e_2=(0,1)，任一向量 (a,b) = a e_1 + b e_2，坐标为 (a,b)。',
              related: ['l3n2'] }
          ]
        },
        {
          name: '第十一章 线性方程组', nodes: [
            { id: 'l4n1', title: '齐次线性方程组', difficulty: 3, exam: 'all',
              content: 'Ax = 0 总有零解；有非零解 \\Leftrightarrow r(A) < n。基础解系含 n - r(A) 个线性无关解向量，通解是基础解系的线性组合。\n\n求基础解系：对 A 行变换成行最简，自由变量依次取 1、其余取 0 回代。',
              example: 'x_1 + x_2 = 0：r = 1, n = 2，基础解系一个向量 (-1, 1)，通解 k(-1,1)。',
              related: ['l1n3', 'l4n2'] },
            { id: 'l4n2', title: '非齐次线性方程组', difficulty: 3, exam: 'all',
              content: 'Ax = b 有解 \\Leftrightarrow r(A) = r(A|b)。\n\nr(A) = r(A|b) = n 唯一解；r(A) = r(A|b) < n 无穷多解（通解 = 特解 + 齐次通解）；r(A) < r(A|b) 无解。\n\n"两个解的差是齐次解；特解加齐次任意解仍是解"是解结构分析的基础。',
              example: 'x_1 + x_2 = 1：一个特解 (1,0)，齐次通解 k(-1,1)，通解 (1,0) + k(-1,1)。',
              related: ['l4n1', 'l2n3'] }
          ]
        },
        {
          name: '第十二章 特征值与相似', nodes: [
            { id: 'l5n1', title: '特征值与特征向量', difficulty: 3, exam: 'all',
              content: '特征方程 |\\lambda E - A| = 0 的根为特征值，对应齐次方程组 (\\lambda E - A)x = 0 的非零解为特征向量。\n\n常用结论：全体特征值之和 = 迹 tr(A)（主对角线元素和），特征值之积 = |A|。A 可逆 \\Leftrightarrow 0 不是特征值。若 \\lambda 是 A 的特征值，则 k\\lambda 是 kA 的特征值，\\lambda^{m} 是 A^{m} 的特征值。',
              example: 'A 的迹为 5、行列式为 6，则两个特征值就是 2 和 3。',
              related: ['l5n2', 'l1n2'] },
            { id: 'l5n2', title: '相似矩阵与对角化', difficulty: 4, exam: 'all',
              content: 'A \\sim B \\Leftrightarrow 存在可逆 P 使 P^{-1}AP = B；相似矩阵有相同特征值、迹、行列式。\n\n可对角化 \\Leftrightarrow A 有 n 个线性无关的特征向量 \\Leftrightarrow 每个特征值的（代数重数 = 几何重数：k 重特征值对应特征向量空间的维数恰为 k）。不同特征值的特征向量必线性无关。',
              example: 'A 有 3 个互不相同的特征值 \\Rightarrow A 可对角化（3 个特征向量无关）。',
              related: ['l5n1', 'l6n2'] },
            { id: 'l5n3', title: '实对称矩阵', difficulty: 4, exam: 'all',
              content: '实对称矩阵三大性质：① 特征值全为实数；② 不同特征值的特征向量必正交；③ 必可正交相似对角化：存在正交阵 Q 使 Q^{-1}AQ = Q^{T}AQ = \\Lambda。\n\n求正交矩阵 Q 的完整流程：求特征值 \\to 求各特征向量 \\to 同一特征值的向量组用施密特正交化 \\to 全体单位化。',
              example: '实对称矩阵必可对角化，这是它和一般矩阵最大的区别。',
              related: ['l5n2', 'l6n1'] }
          ]
        },
        {
          name: '第十三章 二次型', nodes: [
            { id: 'l6n1', title: '二次型与合同变换', difficulty: 3, exam: 'all',
              content: '二次型 f = x^{T}Ax（A 为实对称矩阵）。可逆线性变换 x = Cy 下 A 变为 C^{T}AC，称 A 与 C^{T}AC 合同。\n\n配方法或正交变换化标准形/规范形：正交变换保持几何性质，配方法更应试。惯性定理：规范形中正项个数 p（正惯性指数）与负项个数由 A 唯一确定。',
              example: 'f = x_1^{2} + 2x_2^{2} + 2x_1 x_2 配方法：f = (x_1 + x_2)^{2} + x_2^{2}，正惯性指数 2。',
              related: ['l6n2', 'l5n3'] },
            { id: 'l6n2', title: '正定二次型', difficulty: 3, exam: 'all',
              content: '正定 \\Leftrightarrow 对任意 x \\ne 0 有 x^{T}Ax > 0。判据：① 特征值全为正；② 顺序主子式全为正；③ 正惯性指数 = n；④ 存在可逆 C 使 A = C^{T}C。\n\n负定：顺序主子式正负交替（奇负偶正）。',
              example: 'A = \\begin{bmatrix} 1 & 0 \\\\ 0 & 2 \\end{bmatrix} 特征值 1、2 全正，正定。',
              related: ['l6n1', 'l5n1'] }
          ]
        }
      ]
    },
    {
      id: 'prob', name: '概率论与数理统计', color: '#8a5f17',
      chapters: [
        {
          name: '第十四章 随机事件与概率', nodes: [
            { id: 'p1n1', title: '事件运算与概率基本公式', difficulty: 2, exam: ['m1', 'm3'],
              content: '加法公式：P(A \\cup B) = P(A) + P(B) - P(AB)；独立事件若互斥则至少一个概率为零。\n\n互斥（不相容）与对立：AB = \\varnothing 为互斥；A \\cup B = \\Omega 且互斥为对立，P(\\bar{A}) = 1 - P(A)。\n\n排列组合算古典概型：样本空间中"等可能"是所有古典概型题的前提。',
              example: 'P(A) = 0.4，P(B) = 0.3，A、B 互斥，则 P(A \\cup B) = 0.7。',
              related: ['p1n2'] },
            { id: 'p1n2', title: '条件概率与乘法公式', difficulty: 2, exam: ['m1', 'm3'],
              content: 'P(A|B) = \\frac{P(AB)}{P(B)}（P(B) > 0）。乘法公式：P(AB) = P(A)P(B|A) = P(B)P(A|B)。\n\n独立性：P(AB) = P(A)P(B) \\Leftrightarrow A、B 独立；独立 \\Rightarrow P(A|B) = P(A)。"条件概率里判断独立"是经典陷阱：A 与 B 相互独立时 A 与 \\bar{B} 也独立。',
              example: '袋中 2 红 3 蓝，不放回抽两次，P(两次都红) = \\frac{2}{5} \\times \\frac{1}{4} = \\frac{1}{10}。',
              related: ['p1n1', 'p1n3'] },
            { id: 'p1n3', title: '全概率公式与贝叶斯公式', difficulty: 3, exam: ['m1', 'm3'],
              content: '全概率：若 B_1,...,B_n 构成完备事件组（互斥且并集为 \\Omega），则 P(A) = \\sum P(B_i)P(A|B_i)。\n\n贝叶斯："已知结果反推原因"：P(B_i|A) = \\frac{P(B_i)P(A|B_i)}{\\sum_k P(B_k)P(A|B_k)}，分母就是全概率 P(A)。\n\n应试识别：题目出现"先选箱子/先抽签再抽物 + 已知结果（摸到红球）问来自哪个箱子"即贝叶斯。',
              example: '两台机器 B_1、B_2 产量各占 60% 和 40%，次品率 2% 和 5%，则总次品率 P(A) = 0.6 \\times 0.02 + 0.4 \\times 0.05 = 3.2%。',
              related: ['p1n2'] },
            { id: 'p1n4', title: '古典概型与几何概型', difficulty: 3, exam: ['m1', 'm3'],
              content: '古典概型 P = \\frac{有利结果数}{样本点总数}，关键是分子分母"同一样本空间"计数。\n\n几何概型：向区域 \\Omega 等可能投点，P = \\frac{有利区域面积(长度/体积)}{区域总面积}。\n\n典型模型：不放回抽样、配对问题、重复排列（生日问题）、随机落点。',
              example: '在 [0,2] 上等可能取数，P(得数 > 1.5) = \\frac{0.5}{2} = \\frac{1}{4}（几何概型）。',
              related: ['p1n1'] }
          ]
        },
        {
          name: '第十五章 随机变量及其分布', nodes: [
            { id: 'p2n1', title: '常用离散型分布', difficulty: 2, exam: ['m1', 'm3'],
              content: '0-1 分布 B(1,p)：P(X=1)=p；二项分布 B(n,p)：P(X=k) = C_n^{k} p^{k}(1-p)^{n-k}；泊松分布 P(\\lambda)：P(X=k) = \\frac{\\lambda^{k} e^{-\\lambda}}{k!}。\n\n泊松可近似二项（n 大 p 小，\\lambda = np）。这些分布的两大考点：写分布列与求概率、用分布列求期望方差。',
              example: 'X \\sim B(10, 0.5)，P(X = 0) = (0.5)^{10} = \\frac{1}{1024}。',
              related: ['p2n2', 'p4n1'] },
            { id: 'p2n2', title: '常用连续型分布', difficulty: 2, exam: ['m1', 'm3'],
              content: '均匀 U(a,b)：密度 \\frac{1}{b-a}；指数 E(\\lambda)：密度 \\lambda e^{-\\lambda x}（x > 0），无记忆性 P(X > s+t | X > s) = P(X > t)；正态 N(\\mu, \\sigma^{2})：密度曲线关于 \\mu 对称，标准化 Z = \\frac{X-\\mu}{\\sigma} \\sim N(0,1)。\n\n标准正态查表：\\Phi(x) 对称性、P(|Z| < a) = 2\\Phi(a) - 1。',
              example: 'X \\sim N(1, 4)，则 P(X < 1) = P(Z < 0) = 0.5（对称性）。',
              related: ['p2n1', 'p2n3'] },
            { id: 'p2n3', title: '分布函数与概率密度', difficulty: 2, exam: ['m1', 'm3'],
              content: '分布函数 F(x) = P(X \\le x) 的性质：单调不减、右连续、F(-\\infty)=0、F(+\\infty)=1。\n\n连续型：F\'(x) = f(x)，P(a < X \\le b) = F(b) - F(a) = \\int_a^b f(x)dx，单点概率为 0。\n\n由 F 求 f、由 f 求 F（注意分段）、验证 f 是否是合法密度（积分 = 1 且非负）是基础三问。',
              example: 'U(0,1) 的 F(x)：x < 0 时 0，0 \\le x \\le 1 时 x，x > 1 时 1。',
              related: ['p2n2'] },
            { id: 'p2n4', title: '随机变量函数的分布', difficulty: 3, exam: ['m1', 'm3'],
              content: '离散：把 Y = g(X) 的取值逐个算出并合并概率。\n\n连续：公式法 Y = g(X)（g 严格单调）：f_Y(y) = f_X(g^{-1}(y))|(g^{-1})\'(y)|；或分布函数法：F_Y(y) = P(g(X) \\le y) 再求导。\n\n必记结论：X \\sim N(\\mu,\\sigma^{2}) 且 a \\ne 0 时 aX + b 仍正态；X \\sim U(0,1) 时 Y = -\\ln X \\sim E(1)。',
              example: 'X \\sim U(0,1)，Y = 2X，则 f_Y(y) = \\frac{1}{2}，y \\in (0,2)，即 Y \\sim U(0,2)。',
              related: ['p2n3'] }
          ]
        },
        {
          name: '第十六章 多维随机变量', nodes: [
            { id: 'p3n1', title: '联合分布与边缘分布', difficulty: 3, exam: ['m1', 'm3'],
              content: '二维 (X,Y) 的分布用联合分布列（离散）或联合密度 f(x,y)（连续）刻画。\n\n边缘分布由"对另一变量求和/积分"得到：离散 p_i = \\sum_j p_{ij}；连续 f_X(x) = \\int f(x,y)dy。\n\n二维均匀：区域 D 上 (X,Y) \\sim U(D)，f = \\frac{1}{面积}，算概率 = 面积比（几何概型化）。',
              example: 'f(x,y) = 1（0<x<1, 0<y<1），则 f_X(x) = \\int_0^1 1 \\, dy = 1，X \\sim U(0,1)。',
              related: ['p3n2', 'p2n3'] },
            { id: 'p3n2', title: '随机变量的独立性', difficulty: 3, exam: ['m1', 'm3'],
              content: 'X、Y 独立 \\Leftrightarrow 联合分布 = 边缘分布乘积：离散 p_{ij} = p_i p_j；连续 f(x,y) = f_X(x)f_Y(y)（几乎处处）。\n\n独立变量和的分布：离散卷积公式、正态相加仍正态（X \\sim N(\\mu_1,\\sigma_1^{2})、Y \\sim N(\\mu_2,\\sigma_2^{2}) 独立则 X+Y \\sim N(\\mu_1+\\mu_2, \\sigma_1^{2}+\\sigma_2^{2})）。',
              example: '(X,Y) 独立且 X,Y \\sim N(0,1)，则 X + Y \\sim N(0,2)。',
              related: ['p3n1', 'p2n2'] },
            { id: 'p3n3', title: '协方差与相关系数', difficulty: 3, exam: ['m1', 'm3'],
              content: '协方差 Cov(X,Y) = E[(X-E X)(Y-E Y)] = E(XY) - E X \\cdot E Y。\n\n相关系数 \\rho = \\frac{Cov(X,Y)}{\\sqrt{DX \\cdot DY}} \\in [-1, 1]，|\\rho| = 1 \\Leftrightarrow Y 与 X 几乎线性相关。\n\n独立 \\Rightarrow 不相关（Cov = 0），反之不成立（如 X \\sim N(0,1)，Y = X^{2}，Cov(X,Y) = E(X^{3}) - 0 \\cdot 1 = 0 但不独立）。\n\n方差公式：D(aX + bY) = a^{2}DX + b^{2}DY + 2ab \\cdot Cov(X,Y)。',
              example: 'X \\sim N(0,1)，Y = X^{2}：Cov = 0（不相关）但 Y 完全由 X 决定，不独立。',
              related: ['p4n1', 'p3n2'] }
          ]
        },
        {
          name: '第十七章 数字特征', nodes: [
            { id: 'p4n1', title: '数学期望', difficulty: 2, exam: ['m1', 'm3'],
              content: '离散：E X = \\sum x_i p_i；连续：E X = \\int x f(x) dx。\n\n性质（线性）：E(aX + bY + c) = aEX + bEY + c，无需独立性。\n\n必背期望值：B(n,p) 期望 np；P(\\lambda) 期望 \\lambda；U(a,b) 期望 \\frac{a+b}{2}；E(\\lambda) 期望 \\frac{1}{\\lambda}；N(\\mu,\\sigma^{2}) 期望 \\mu。EkX = kEX。',
              example: 'X \\sim B(10, 0.4)，则 E X = 4。',
              related: ['p4n2', 'p2n1'] },
            { id: 'p4n2', title: '方差与标准差', difficulty: 2, exam: ['m1', 'm3'],
              content: 'D X = E(X^{2}) - (E X)^{2}（算方差的最常用公式）。\n\n性质：D(aX + b) = a^{2}DX；X、Y 独立时 D(X \\pm Y) = DX + DY。\n\n必背方差：B(n,p) 方差 np(1-p)；P(\\lambda) 方差 \\lambda；U(a,b) 方差 \\frac{(b-a)^{2}}{12}；E(\\lambda) 方差 \\frac{1}{\\lambda^{2}}；N(\\mu,\\sigma^{2}) 方差 \\sigma^{2}。',
              example: 'X \\sim P(3)，则 E X = D X = 3（泊松分布期望方差相等）。',
              related: ['p4n1'] }
          ]
        },
        {
          name: '第十八章 大数定律与中心极限定理', nodes: [
            { id: 'p5n1', title: '大数定律', difficulty: 3, exam: ['m1', 'm3'],
              content: '切比雪夫不等式：P(|X - EX| \\ge \\varepsilon) \\le \\frac{DX}{\\varepsilon^{2}}——用期望方差粗估概率的上界。\n\n伯努利大数定律：试验次数 n 充分大时，频率依概率收敛于概率（"频率的稳定性"）。\n\n辛钦大数定律：独立同分布且期望存在时，\\frac{1}{n}\\sum X_i 依概率收敛于 E X。',
              example: 'DX = 1 时 P(|X - EX| \\ge 2) \\le \\frac{1}{4}（切比雪夫）。',
              related: ['p5n2', 'p4n1'] },
            { id: 'p5n2', title: '中心极限定理', difficulty: 3, exam: ['m1', 'm3'],
              content: '林德伯格-莱维（独立同分布）：X_i 独立同分布、\\sigma^{2} > 0，则 \\frac{\\sum X_i - n\\mu}{\\sqrt{n}\\sigma} 近似服从 N(0,1)。\n\n实际应用：\\sum X_i 近似 N(n\\mu, n\\sigma^{2})，配合标准化计算概率。\n\n题型：n 次独立重复试验的总量/平均量落在某范围内的概率，如"至少安装多少部电梯才 98% 够用"。',
              example: '掷 100 次骰子，总点数近似 N(350, \\frac{100 \\times 35}{12})，可据此估算总点数范围内的概率。',
              related: ['p5n1', 'p2n2'] }
          ]
        },
        {
          name: '第十九章 数理统计', nodes: [
            { id: 'p6n1', title: '统计量、样本均值与方差', difficulty: 2, exam: ['m1', 'm3'],
              content: '简单随机样本 X_1,...,X_n 独立同分布。样本均值 \\bar{X} = \\frac{1}{n}\\sum X_i；样本方差 S^{2} = \\frac{1}{n-1}\\sum (X_i - \\bar{X})^{2}（注意分母 n-1，保证无偏）。\n\n\\bar{X} ~ N(\\mu, \\frac{\\sigma^{2}}{n})；E S^{2} = \\sigma^{2}。\n\n三大抽样分布：\\chi^{2}（平方和）、t（正态比 \\chi^{2} 根号）、F（两个 \\chi^{2} 之比），做区间估计和假设检验的基础。',
              example: 'X_1,...,X_n \\sim N(\\mu,\\sigma^{2})，则 \\frac{\\bar{X} - \\mu}{S/\\sqrt{n}} \\sim t(n-1)。',
              related: ['p6n2', 'p2n2'] },
            { id: 'p6n2', title: '矩估计与极大似然估计', difficulty: 4, exam: ['m1', 'm3'],
              content: '矩估计：令样本矩 = 总体矩（一阶：\\bar{X} = E X），解出参数。\n\n极大似然估计：写出似然函数 L(\\theta) = \\prod f(x_i; \\theta)，取对数、对 \\theta 求导令为零（或直接看 L 的单调性），解出 \\hat{\\theta}。\n\n常规模型（指数/正态/均匀分布）的 MLE 要会算；判断无偏用 E \\hat{\\theta} = \\theta。',
              example: 'X \\sim E(\\lambda)，样本均值 \\bar{X}：矩估计 \\hat{\\lambda} = \\frac{1}{\\bar{X}}；似然同样得到 \\frac{n}{\\sum x_i} = \\frac{1}{\\bar{X}}。',
              related: ['p6n1', 'p2n2'] },
            { id: 'p6n3', title: '区间估计与假设检验', difficulty: 3, exam: ['m1'],
              content: '正态总体均值 \\mu 的置信区间（\\sigma^{2} 已知）：\\bar{X} \\pm z_{\\alpha/2}\\frac{\\sigma}{\\sqrt{n}}。\n\n假设检验：原假设 H_0 与备择 H_1，构造检验统计量（t 或 z），按显著性水平 \\alpha 查临界值；犯第一类错误（弃真）概率为 \\alpha。\n\n核心思想：小概率事件在一次试验中几乎不发生，观测值落入拒绝域则拒绝 H_0。',
              example: '检验 H_0: \\mu = \\mu_0 用统计量 Z = \\frac{\\bar{X} - \\mu_0}{\\sigma/\\sqrt{n}}，|Z| > z_{\\alpha/2} 时拒绝。',
              related: ['p6n1'] }
          ]
        }
      ]
    }
  ]
};