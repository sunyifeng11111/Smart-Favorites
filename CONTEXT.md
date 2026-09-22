# Smart Favorites

Smart Favorites helps a person save the current webpage into the most suitable folder in their existing Chrome bookmark structure, while keeping the person in control when the classification is uncertain.

## Language

**智能收藏（Smart Save）**:
由用户主动发起、为当前网页选择目录并创建一个 Chrome 收藏的完整操作。
_Avoid_: 自动整理、智能归档

**可分类目录（Eligible Folder）**:
现有收藏目录中允许参与本次分类的目录；被用户排除或不可用于收藏的节点不属于可分类目录。
_Avoid_: 清晰目录、有效目录

**目录示例（Folder Example）**:
用户曾确认归入某个目录的网页，用来表达该目录对当前用户的实际含义。
_Avoid_: 训练数据、文件夹规则

**分类纠正（Classification Correction）**:
用户以手动选择覆盖系统给出的目录结果，并将最终选择确认成新的目录示例。
_Avoid_: 错误反馈、重新训练

**自动收藏（Automatic Save）**:
当分类结果达到可信标准时，系统在用户确认目录之前完成的智能收藏；该操作仍必须允许用户更改或撤销。
_Avoid_: 静默收藏、强制分类

**候选目录（Folder Candidate）**:
分类不够确定时，按适合程度展示给用户确认的一组可分类目录。
_Avoid_: 推荐分类、备选标签

**待分类目录（Pending Folder）**:
没有合适的可分类目录、没有可分类目录或分类服务失败时接收收藏的唯一兜底目录。
_Avoid_: 其他、默认目录

**重复收藏（Duplicate Bookmark）**:
当前网页与已有收藏代表同一网页的情形；是否仍要创建、保留原位置或移动，必须由用户明确决定。
_Avoid_: 重复网页、冲突收藏

**历史收藏（Existing Bookmark）**:
在当前智能收藏开始前已经存在的收藏；系统不得自动移动或删除它，只有用户对该收藏的明确操作可以改变其位置。
_Avoid_: 旧收藏、遗留收藏

**撤销（Undo）**:
恢复到本次智能收藏开始前的收藏状态，只逆转能够明确归因于本次操作的变化。
_Avoid_: 删除、回退分类

**最近记录（Recent Record）**:
保存在本机、用于查看和处理近期智能收藏结果的操作摘要，不包含网页正文、密钥或完整模型请求。
_Avoid_: 浏览历史、审计日志

**验收集（Evaluation Set）**:
一组预先标注正确目录、且不作为目录示例使用的固定网页，用于可重复地测量分类质量。
_Avoid_: 训练集、示例库

**自动收藏精确率（Automatic Save Precision）**:
验收集中被自动收藏的网页里，最终进入人工标注目录的比例。
_Avoid_: 第一推荐准确率、模型置信度

**自动收藏覆盖率（Automatic Save Coverage）**:
验收集中无需用户确认便完成自动收藏的网页所占比例，用来说明自动收藏精确率覆盖了多少实际情况。
_Avoid_: 自动化率、召回率
