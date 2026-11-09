#!/usr/bin/env python3
"""Build source-exact editorial candidates. No semantic link receives human approval here."""
from pathlib import Path
import hashlib, json, re

ROOT=Path('public/data/corpus')
NORMALIZATION='unicode-nfc-lf-v1'
DOCS={}
def doc(region):
    id='regional-'+region
    if id not in DOCS: DOCS[id]=json.loads((ROOT/'documents'/f'{id}.json').read_text())
    return DOCS[id]
def ref(page,ordinal): return (page,ordinal)
def block(d, r):
    id=f"{d['meta']['id']}-p{r[0]:03d}-b{r[1]:03d}"
    return next(x for x in d['version']['blocks'] if x['id']==id)
def occurrence(d,id,refs,note):
    blocks=sorted([block(d,r) for r in refs],key=lambda b:b['order'])
    spans=[]
    for b in blocks:
        text=b['text']; exact=text.strip(); start=text.index(exact); end=start+len(exact)
        spans.append({'blockId':b['id'],'start':start,'end':end,'exact':exact,'prefix':text[max(0,start-48):start],'suffix':text[end:end+48]})
    a={'id':'anchor-'+id,'documentId':d['meta']['id'],'versionId':d['version']['id'],
       'normalizationVersion':NORMALIZATION,'spans':spans}
    return {'id':id,'documentId':d['meta']['id'],'versionId':d['version']['id'],
       'anchor':a,'reviewStatus':'candidate','note':note,
       'sourceQuoteValidation':'exact-match','pageStart':blocks[0]['pageStart'],'pageEnd':blocks[-1]['pageEnd'],
       'sourceUrl':d['version']['sourceUrl']+'#page='+str(blocks[0]['pageStart']),
       'sourceSha256':d['version']['sourceSha256'],'humanReviewRequired':True}

SPECS=[
{
'id':'mordovia-kindergarten-compensation','familyId':'kindergarten-fee-compensation','regionId':'respublika-mordoviia',
'title':'Компенсация родительской платы за детский сад',
'mechanism':'Возмещение части среднего размера родительской платы, ограниченное фактически внесённой платой.',
'eligibility':'Родители детей в государственных и муниципальных дошкольных образовательных организациях Республики Мордовия.',
'amount':'Первый ребёнок: 20–29%; второй: 50–72%; третий и последующие: 70–100% среднего размера платы; не выше фактической платы.',
'conditions':['Проценты различаются по очередности рождения; условия выбора конкретного процента в приведённом фрагменте не раскрыты.'],
'implementationStatus':'described-existing','theme':'childcare','lifecycleStages':['childcare','next-child'],
'fieldRefs':{'title':[(59,3)],'mechanism':[(59,3),(59,4),(59,5),(59,6)],'eligibility':[(59,3)],'amount':[(59,4),(59,5),(59,6)]},
'catalogId':'sovetmam:mord-004','catalogRelation':'partial','catalogNote':'Каталог указывает только20/50/70%. Программа содержит диапазоны20–29/50–72/70–100. Не заменять диапазоны значениями каталога.',
},
{
'id':'mordovia-student-childcare','familyId':'student-parent-childcare','regionId':'respublika-mordoviia',
'title':'Компенсация детского сада родителям-студентам',
'mechanism':'Компенсация студентам расходов на содержание ребёнка в муниципальном детском саду.',
'eligibility':'Студенты, имеющие детей в муниципальных дошкольных образовательных организациях.',
'amount':'В размере фактических расходов родителей на содержание ребёнка.',
'conditions':['Состав подтверждающих документов и дополнительные критерии в выбранном фрагменте не приведены.'],
'implementationStatus':'described-existing','theme':'education','lifecycleStages':['childcare','education-work'],
'fieldRefs':{x:[(59,8)] for x in ['title','mechanism','eligibility','amount']},
},
{
'id':'mordovia-mortgage-repayment','familyId':'mortgage-repayment-at-birth','regionId':'respublika-mordoviia',
'title':'Снижение ипотечного долга при рождении детей',
'mechanism':'Социальная выплата на частичное или полное погашение ипотечного кредита, включая рефинансированный.',
'eligibility':'Для детей, родившихся после получения ипотеки, и отдельно для малоимущих семей с двумя и более детьми, рождёнными до получения ипотеки.',
'amount':'После получения ипотеки: по10% за первого и второго ребёнка,30% за третьего,полное погашение за четвёртого; для ранее рождённых детей предусмотрены отдельные условия.',
'conditions':['Для малоимущих семей с детьми, рождёнными до получения ипотеки:10–20% в зависимости от числа детей, при пяти детях — полное погашение.','Сохранены две различные группы условий; они не объединены в универсальную льготу.'],
'implementationStatus':'described-existing','theme':'housing','lifecycleStages':['first-child','next-child'],
'fieldRefs':{'title':[(60,8),(60,9)],'mechanism':[(60,8)],'eligibility':[(60,9),(60,10)],'amount':[(60,9),(60,10)]},
'catalogId':'sovetmam:mord-003','catalogRelation':'mechanism-only','catalogNote':'Каталог описывает общий механизм без процентов и двух групп условий; сумма и право подтверждаются только цитатами программы этой редакции.',
},
]

SPECS.extend([
{
'id':'mordovia-flexible-work','familyId':'family-friendly-work','regionId':'respublika-mordoviia',
'title':'Гибкий график для родителей детей до14лет',
'mechanism':'Рекомендация работодателям закреплять семейные гарантии в коллективных договорах: гибкий график по договорённости.',
'eligibility':'Женщины (родители), имеющие детей до14лет; по договорённости с работодателем.',
'amount':None,'conditions':['В документе это рекомендация работодателям, а не безусловное право на новую денежную выплату.'],
'implementationStatus':'recommended','theme':'work','lifecycleStages':['childcare','education-work','next-child'],
'fieldRefs':{'title':[(64,7)],'mechanism':[(63,11),(64,7)],'eligibility':[(64,7)]},
},
{
'id':'mordovia-first-child-proposal','familyId':'first-birth-payment','regionId':'respublika-mordoviia',
'title':'Предложение выплаты150тыс.рублей при рождении первенца до25лет',
'mechanism':'Предложено введение новой единовременной выплаты женщинам при рождении первого ребёнка.',
'eligibility':'Женщина, родившая первого ребёнка в возрасте до25лет; условия предложения из программы.',
'amount':'150000рублей — предложенная, а не подтверждённая действующая сумма.',
'conditions':['Абзац содержит слова «предлагается введение». Нельзя показывать его как установленную действующую выплату.','Указанный в программе ожидаемый прирост рождений не является оценкой причинного эффекта.'],
'implementationStatus':'proposed','theme':'income','lifecycleStages':['first-child'],
'fieldRefs':{x:[(64,11)] for x in ['title','mechanism','eligibility','amount']},
'catalogId':'sovetmam:mord-001','catalogRelation':'different-conditions-and-amount',
'catalogNote':'Каталог описывает100000руб. для рождений01.07.2025–01.07.2026; фрагмент программы предлагает150000руб. до25лет. Это не взаимозаменяемые утверждения; связь лишь тематическая, назначение и редакцию надо проверить.',
},
{
'id':'perm-young-family-housing','familyId':'young-family-housing','regionId':'permskii-krai',
'title':'Краевая жилищная выплата молодой семье',
'mechanism':'Социальная выплата участникам краевого направления программы «Молодая семья».',
'eligibility':'Молодые семьи — участники краевого направления; в порядке очередности без приоритетных категорий.',
'amount':'10% расчётной (средней) стоимости жилья.',
'conditions':['Краевое направление с10% отделено от федерального направления с30–35%, описанного соседним абзацем.'],
'implementationStatus':'described-existing','theme':'housing','lifecycleStages':['family-formation','first-child','next-child'],
'fieldRefs':{x:[(61,10)] for x in ['title','mechanism','eligibility','amount']},
},
{
'id':'perm-family-case-management','familyId':'family-case-management','regionId':'permskii-krai',
'title':'Сопровождение беременных и семей с ребёнком до1года',
'mechanism':'Муниципальные офисы отделений сопровождения: социально-бытовой патронаж, психологические и правовые услуги.',
'eligibility':'Беременные женщины и семьи с детьми от0до1года — прямо названные в фрагменте целевые группы.',
'amount':None,
'conditions':['В тексте упомянуто признание нуждаемости в социальном обслуживании; конкретный порядок допуска требует отдельной нормативной проверки.','Число охваченных услугой семей не доказывает изменение рождаемости.'],
'implementationStatus':'described-existing','theme':'services','lifecycleStages':['pregnancy','first-child','childcare'],
'fieldRefs':{'title':[(38,5),(38,7)],'mechanism':[(38,5),(38,8),(38,9),(38,10)],'eligibility':[(38,7)]},
},
{
'id':'perm-school-goods-assistance','familyId':'school-start-support','regionId':'permskii-krai',
'title':'Материальная помощь на школьные товары',
'mechanism':'Срочная социальная услуга нуждающимся семьям один раз в учебном году.',
'eligibility':'Малоимущие и многодетные малоимущие семьи, семьи в социально опасном положении, на социальном обслуживании на дому или в группе риска.',
'amount':'5000рублей один раз в учебном году; единица назначения на семью или ребёнка в абзаце не уточнена.',
'conditions':['Нельзя автоматически приравнивать к отдельной выплате на школьную форму из каталога.'],
'implementationStatus':'described-existing','theme':'income','lifecycleStages':['school','next-child'],
'fieldRefs':{'title':[(65,4)],'mechanism':[(65,4)],'eligibility':[(65,4),(65,5),(65,6),(65,7),(65,8)],'amount':[(65,4)]},
'catalogId':'sovetmam:perm-009','catalogRelation':'possibly-distinct-measure',
'catalogNote':'В каталоге3500руб. на школьную форму многодетным малоимущим, в программе5000руб. на школьные товары нескольким категориям. Автоматическое объединение запрещено до проверки основания.',
},
{
'id':'tambov-newborn-payment','familyId':'first-birth-payment','regionId':'tambovskaia-oblast',
'title':'Выплата5000рублей на каждого рождённого ребёнка',
'mechanism':'Единовременная выплата в Тамбовской области независимо от очередности рождения.',
'eligibility':'Дети, родившиеся с01.10.2022по31.12.2025включительно; срок указан в сохранённой редакции.',
'amount':'5000рублей на каждого ребёнка.',
'conditions':['Окончание периода рождений в источнике:31.12.2025. Продление нормы этим корпусом не подтверждено.'],
'implementationStatus':'period-ended-in-source','theme':'income','lifecycleStages':['first-child','next-child'],
'fieldRefs':{x:[(66,3)] for x in ['title','mechanism','eligibility','amount']},
'catalogId':'sovetmam:tamb-003','catalogRelation':'mechanism-only',
'catalogNote':'В каталоге отсутствуют сумма5000руб. и точный период рождений. Они происходят из архивной программы, а не из карточки каталога.',
},
{
'id':'tambov-large-family-housing-fee','familyId':'large-family-housing-expenses','regionId':'tambovskaia-oblast',
'title':'Компенсация платы за жилое помещение многодетным',
'mechanism':'Новая мера по Закону Тамбовской области11.06.2024№505-З, описанная в региональной программе.',
'eligibility':'Многодетные семьи Тамбовской области; дополнительные условия получения в выбранном абзаце не раскрыты.',
'amount':'30% суммы платы за жилое помещение.',
'conditions':['Плата за жилое помещение и коммунальные услуги — разные базы расчёта.'],
'implementationStatus':'described-existing','theme':'housing','lifecycleStages':['next-child','childcare','school'],
'fieldRefs':{x:[(66,6)] for x in ['title','mechanism','eligibility','amount']},
'catalogId':'sovetmam:zhku-mnogodetnym-tambov','catalogRelation':'different-calculation-base',
'catalogNote':'Карточка каталога про30% коммунальных услуг. Цитата программы про30% платы за жилое помещение. Одинаковый процент не доказывает тождество меры.',
},
{
'id':'tambov-student-budget-transfer','familyId':'student-parent-education','regionId':'tambovskaia-oblast',
'title':'Перевод родивших студенток СПО на бюджетное обучение',
'mechanism':'Перевод с платного обучения на обучение за счёт средств бюджета Тамбовской области.',
'eligibility':'Студентки организаций СПО, обучающиеся по договорам об оказании платных образовательных услуг и родившие ребёнка во время обучения.',
'amount':None,
'conditions':['Сроки мероприятия в таблице:30.08.2021–31.12.2027. Денежная стоимость на получателя в строке не установлена.'],
'implementationStatus':'described-existing','theme':'education','lifecycleStages':['first-child','education-work'],
'fieldRefs':{x:[(86,4)] for x in ['title','mechanism','eligibility']},
},
{
'id':'tambov-student-family-dormitory','familyId':'student-parent-housing','regionId':'tambovskaia-oblast',
'title':'Комната в общежитии родителям-студентам СПО',
'mechanism':'Предоставление комнаты в студенческом общежитии родителям-студентам.',
'eligibility':'Родители-студенты СПО, имеющие детей.',
'amount':None,
'conditions':['Размер платы за общежитие и порядок приоритетного распределения в выбранной строке не указаны.'],
'implementationStatus':'described-existing','theme':'housing','lifecycleStages':['first-child','education-work','childcare'],
'fieldRefs':{x:[(86,5)] for x in ['title','mechanism','eligibility']},
},
{
'id':'sakhalin-private-childcare','familyId':'private-childcare-compensation','regionId':'sakhalinskaia-oblast',
'title':'Компенсация стоимости частного ухода за ребёнком',
'mechanism':'Компенсация части платы частной организации за присмотр и уход за детьми.',
'eligibility':'Родители или законные представители детей от2месяцев до7лет, посещающих частные организации в Сахалинской области.',
'amount':'50% установленной частной организацией платы, но не более10000рублей на ребёнка в месяц.',
'conditions':['Ставка и месячный предел действуют совместно; нельзя представлять10000рублей как безусловную выплату.'],
'implementationStatus':'described-existing','theme':'childcare','lifecycleStages':['childcare','education-work','next-child'],
'fieldRefs':{x:[(37,10)] for x in ['title','mechanism','eligibility','amount']},
'catalogId':'sovetmam:sah-002','catalogRelation':'consistent-in-selected-fields',
'catalogNote':'Выбранные поля механизма, возраста и предела совпадают. Актуальность нормы и полный порядок назначения не проверены.',
},
{
'id':'sakhalin-kindergarten-compensation','familyId':'kindergarten-fee-compensation','regionId':'sakhalinskaia-oblast',
'title':'Компенсация родительской платы:20/50/100%',
'mechanism':'Компенсация родителям части среднего размера родительской платы за дошкольную образовательную организацию.',
'eligibility':'Родители или законные представители детей, посещающих дошкольные образовательные организации; размер зависит от очередности ребёнка.',
'amount':'20% на первого ребёнка;50% на второго;100% на третьего и последующих.',
'conditions':['При сравнении с Мордовией сохраняются разные диапазоны, база расчёта и ограничения.'],
'implementationStatus':'described-existing','theme':'childcare','lifecycleStages':['childcare','next-child'],
'fieldRefs':{x:[(37,11)] for x in ['title','mechanism','eligibility','amount']},
'catalogId':'sovetmam:sah-001','catalogRelation':'consistent-in-selected-fields',
'catalogNote':'Проценты совпадают с фрагментом программы; это не проверка всех критериев назначения и действующего размера.',
},
{
'id':'sakhalin-rental-house-compensation','familyId':'family-rental-housing','regionId':'sakhalinskaia-oblast',
'title':'Компенсация50% взносов за арендное жильё',
'mechanism':'Компенсация расходов по оплате ежемесячных взносов за аренду жилья в многоквартирном арендном доме.',
'eligibility':'Отдельные категории семей с детьми: молодые, многодетные и семьи с детьми-инвалидами.',
'amount':'50% ежемесячных взносов за аренду жилья.',
'conditions':['Мера привязана к многоквартирному арендному дому; не ко всякой частной аренде квартиры.'],
'implementationStatus':'described-existing','theme':'housing','lifecycleStages':['family-formation','first-child','next-child'],
'fieldRefs':{x:[(37,8)] for x in ['title','mechanism','eligibility','amount']},
},
])

FAMILIES={
'kindergarten-fee-compensation':('Компенсация платы за детский сад','Возмещение родительской платы'),
'student-parent-childcare':('Уход за детьми родителей-студентов','Компенсация расходов на уход'),
'mortgage-repayment-at-birth':('Погашение ипотеки при рождении детей','Уменьшение ипотечного долга'),
'family-friendly-work':('Совмещение работы и родительства','Изменение условий занятости'),
'first-birth-payment':('Выплата при рождении ребёнка','Единовременная денежная выплата'),
'young-family-housing':('Жильё для молодой семьи','Социальная выплата на жильё'),
'family-case-management':('Сопровождение семьи','Индивидуальная социальная помощь'),
'school-start-support':('Помощь к учебному году','Материальная помощь на школьные товары'),
'large-family-housing-expenses':('Расходы многодетной семьи на жильё','Компенсация платы за жилое помещение'),
'student-parent-education':('Образование родителей-студентов','Перевод на бюджетное обучение'),
'student-parent-housing':('Жильё родителей-студентов','Комната в студенческом общежитии'),
'private-childcare-compensation':('Доступность частного ухода за детьми','Компенсация стоимости частного детского сада'),
'family-rental-housing':('Аренда жилья для семьи','Компенсация арендной платы'),
}

def build():
    catalog=json.loads((ROOT/'family-catalog.json').read_text())
    cats={x['id']:x for x in catalog['measures']}
    variants=[]; occurrences=[]; comparisons=[]
    for spec in SPECS:
        d=doc(spec['regionId']); refs=spec['fieldRefs']
        v={k:val for k,val in spec.items() if k not in ['fieldRefs','catalogRelation','catalogNote']}
        for field in ['title', 'mechanism', 'eligibility', 'amount']:
            if isinstance(v.get(field), str):
                v[field]=re.sub(r'(?<=[А-Яа-яЁё])(?=[0-9])|(?<=[0-9])(?=[А-Яа-яЁё])', ' ', v[field])
        v['conditions']=[re.sub(r'(?<=[А-Яа-яЁё])(?=[0-9])|(?<=[0-9])(?=[А-Яа-яЁё])', ' ', x) for x in v.get('conditions', [])]
        v.update({'occurrenceIds':[],'evidence':[],'reviewStatus':'candidate','regionName':d['meta']['regionName'],
            'documentId':d['meta']['id'],'editionLabel':d['version']['editionLabel'],'sourceUrl':d['source']['sourceUrl'],
            'legalCurrency':'unverified','effectiveness':'unverified',
            'verificationNote':'Цитаты и хеши проверены автоматически. Семантические связи подготовлены ассистентом и требуют подтверждения преподавателем. Это не проверка действующего права или эффективности меры.'})
        for field, selection in refs.items():
            id=f"occ-{spec['id']}-{field}"
            o=occurrence(d,id,selection,'Точный фрагмент сохранённой редакции. Семантическое соответствие полю ожидает проверки преподавателем.')
            occurrences.append(o); v['occurrenceIds'].append(id)
            v['evidence'].append({'kind':'fragment','field':field,'occurrenceId':id,'relation':'supports',
                'reviewStatus':'candidate','reviewedValue':v[field],
                'note':'Редакционная кандидатура; статус verified устанавливается только после явного подтверждения человеком.'})
        if spec.get('catalogId'):
            item=cats[spec['catalogId']]
            v['catalogSourceUrl']=item['source_url']
            comparisons.append({'variantId':v['id'],'catalogId':item['id'],'relation':spec['catalogRelation'],
                'note':spec['catalogNote'],'reviewStatus':'candidate','catalogSnapshot':item,
                'catalogProvenance':catalog['source'],'notUsedAsProgramEvidence':True})
        variants.append(v)
    families=[{'id':id,'title':FAMILIES[id][0],'mechanism':FAMILIES[id][1],
               'description':'Семейство объединяет механизм; региональные условия, суммы и редакции сохраняются в вариантах.'}
              for id in dict.fromkeys(v['familyId'] for v in variants)]
    result={'schemaVersion':1,'normalizationVersion':NORMALIZATION,'offsetEncoding':'unicode-code-points',
        'status':'editorial-candidates-source-exact-human-review-pending','sourceCommit':'5dde46ae663b7652a448ec982585e64d61a26a61',
        'families':families,'variants':variants,'occurrences':occurrences,'catalogComparisons':comparisons}
    (ROOT/'practices.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(f'{len(variants)} variants;{len(occurrences)} field-specific exact occurrences;{len(comparisons)} catalog comparisons.')

if __name__=='__main__': build()
