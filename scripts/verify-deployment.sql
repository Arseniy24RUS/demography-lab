-- Demography Workshop 0.8: owner-side, read-only deployment verification.
-- Run after the six shipped migrations (Stages 2-6 and 8), or their reconciled cloud parts.
-- No email, names, answer content, keys or tokens are returned. Every statement is SELECT-only.
-- A missing-object error means migration is incomplete. No administrative issuer is invoked.
-- Declared email does not use SMTP; actual HTTP login and API exposure need separate checks.

-- 1. Runtime context; no credentials.
select current_database() as database_name, current_user as sql_role,
       current_setting('server_version') as postgres_version;

-- 2. Expected migration identities. MCP-assigned versions must be reconciled with
-- local filenames only after verifying the exact applied SQL content.
select version,name from supabase_migrations.schema_migrations order by version;

-- 3. Canonical import totals: 80 / 80 / 52390 / 0.
select (select count(*) from private.source_versions) as source_editions,
       (select count(*) from private.source_versions where sealed) as sealed_editions,
       (select count(*) from private.source_blocks) as source_blocks,
       (select count(*) from private.source_versions where not sealed) as unfinished_editions;

-- 4. Exact full-row digest of every pinned source; every row must be passed=true.
with expected(version_id,block_count,rows_sha256) as (values
  ('regional-altaiskii-krai@layout-canonical-v2-35ee7dabdc39-67a15ae6b981',400,'0598f956fb177197eca111fe107cd7ee7fb51787bcd8eceea924fb3fcd7f10d0'),
  ('regional-amurskaia-oblast@layout-canonical-v2-8bc02286a7cf-d51efa79698a',1495,'9b64880955ac66305d8cdacbfe38f84fff0ff61d80f011a2ed9e99d65d6d9116'),
  ('regional-arkhangelskaia-oblast@layout-canonical-v2-8a9d518f19eb-4551c0dff849',968,'1de7da91a47db658bfd6b2f52d2ef3d0a7b810a23fb3395e4b7428b328a22b01'),
  ('regional-astrakhanskaia-oblast@layout-canonical-v2-cf05683f099a-dd98ab663617',619,'9efd6829d36692b608585ab7fcfecba2e976912fe75c94021eed2e6e9e9aee17'),
  ('regional-belgorodskaia-oblast@layout-canonical-v2-b2faffb5c23e-c6458e66f8dc',707,'6a9fab38969ea1337331e2e177b7f00dd300ca6150a3147f7b26062147d6af10'),
  ('regional-brianskaia-oblast@layout-canonical-v2-fc51bd2df7e2-a705fb987bb0',534,'b6e90edff4a6ea2cd5e9032877136c6d84f931ece88ab4952c4aa35f24d34ad3'),
  ('regional-vladimirskaia-oblast@layout-canonical-v2-4aa0119ce0a1-dfbdc85c3231',534,'40432e710ac11c2b2a097873e05a25448d7f17c672649e97cb69f27ca1ef36d4'),
  ('regional-vologodskaia-oblast@layout-canonical-v2-b4ecb4b1e9ac-34b4e4ab9154',198,'4b8ccb242f44e4f0d25516770a6f460523c550f2251cfc77c88f5702b66e7ca1'),
  ('regional-voronezhskaia-oblast@layout-canonical-v2-d4f883f7b28e-f14474bea84d',384,'26a79fbcbfaf15ff5f1852f075d8e56d25d475c45c6ab68d5ebf612cb2345ef8'),
  ('regional-evreiskaia-avtonomnaia-oblast@layout-canonical-v2-5bf4adecff6e-2efcf6bc2848',430,'fc7c9e82af210c9349e4c5f8322e6345441bf2e25a3c07d8afa20a00a67920f9'),
  ('regional-zabaikalskii-krai@layout-canonical-v2-50cd5e54771b-20f6950e695e',803,'a9c3e02be79cf335cf7954de0cb0a4ad384b04e471f6be60f4d4b59e30fb2909'),
  ('regional-ivanovskaia-oblast@layout-canonical-v2-e70664e9eff5-31a62f2c8e6b',610,'13c2abe9e01c8c67bd5b39008373cb6358f8327e5740ca42c9efdeceebdfd63c'),
  ('regional-irkutskaia-oblast@layout-canonical-v2-24caf808d420-6ac8c007a568',1149,'02f1331c3e3abcaf8ecd788a01f808ec96998115789c9a11d39cb320732410f5'),
  ('regional-kabardino-balkarskaia-respublika@layout-canonical-v2-d4c65f22c8e7-d1cdb23e5884',203,'18f2b256f5b56865520e3b16a815538e82df4328332cb26acb5704b5ddf23950'),
  ('regional-kaliningradskaia-oblast@layout-canonical-v2-7d5be920518f-91548092f5bb',820,'db1e3eebefb0f7b1b89178412ce5a171ce9b79f950e723052ec9f94e37a3f064'),
  ('regional-kaluzhskaia-oblast@layout-canonical-v2-cdffd4d0f1ca-91b5c2d7da56',630,'88159994bd7499fb41a20450edb7cbae3157b93129262f4a427736fdc0fc5ebb'),
  ('regional-karachaevo-cherkesskaia-respublika@layout-canonical-v2-4ca0df010d98-b391ae44b344',353,'137270941bf38beae2d91793eec27ad90fa371fbc7f16e3880e5d64a6b1db6e6'),
  ('regional-kemerovskaia-oblast-kuzbass@layout-canonical-v2-aa24e732cddc-edb5b5453e0a',797,'74c9b89cfbc74917f5e5915e19d69c0908acad6568e88a0a20efaa04978e9632'),
  ('regional-kirovskaia-oblast@layout-canonical-v2-c2fef33c7058-e1fbdb4e6eb1',969,'4f178ce5c2b10a12dd22da741e595e37491793da992ecd16a8d5e25be7996c75'),
  ('regional-kostromskaia-oblast@layout-canonical-v2-585533b66669-1a5f8c0f1e06',1660,'74a90c2afdcf0ea360d8a6f6af98688785dd67b0054b0f113bb5735b9c85319b'),
  ('regional-krasnodarskii-krai@layout-canonical-v2-06d655e4a4dc-e4fad39b118a',851,'00a7ce1183885596a1ed30391406d55400c398897a14b67a5d3a0eb5e73fb7ef'),
  ('regional-krasnoiarskii-krai@layout-canonical-v2-1403161f25ea-88aac25de5ac',684,'7714dd6870ea988e2c50a669db4a847929332f2b0060a8505d50ad3c4e86820a'),
  ('regional-kurganskaia-oblast@layout-canonical-v2-777f773fd97f-daf007748a42',295,'9cd427d3d14b961ee44f4cc179306ba9d820c2ff44dc36951cdcf9c30fe8cf3a'),
  ('regional-kurskaia-oblast@layout-canonical-v2-3f413f1713ff-61d348704b6e',392,'b4fb8dfc68e04417d764da1bb61ef40c94dbd3826e0e3149d9103298e6b51467'),
  ('regional-leningradskaia-oblast@layout-canonical-v2-9bd09bb56e48-1a7b199c168c',1113,'cd0c6e56869634ad741334d19a771d3d9c713534df528f9cf53818033bcfcf54'),
  ('regional-lipetskaia-oblast@layout-canonical-v2-3638686c6f90-dc9b1d7515fd',581,'6eae78b2edd9764d0202169984dea33e70a6801cd5921d03fa24fbe2f998e5bb'),
  ('regional-magadanskaia-oblast@layout-canonical-v2-58be9d4061eb-9cfd62a589bd',377,'da5d674c28b1625d92772f785f8bf600522e8243253202f85e10bc53ae7bf258'),
  ('regional-moskovskaia-oblast@layout-canonical-v2-5397d0769bde-e93cd2ea0455',391,'874ff443cbf1dc485c5fd48fd90fc56c170afafc393477d089d7aa0cb143aba4'),
  ('regional-murmanskaia-oblast@layout-canonical-v2-55fa256a11e6-8371cae14f0e',632,'96518cabc14871381d378ef5d7f9d72491472268441f7743e03d07c82ff22c60'),
  ('regional-nizhegorodskaia-oblast@layout-canonical-v2-e4775ee9a334-d51dcda550c0',570,'f1414d428a50654a9046b5b0db2b225b672bab883512ed9f753256c74d7e10f2'),
  ('regional-novgorodskaia-oblast@layout-canonical-v2-71e23281d6a6-6d64aacc269f',396,'e59fbeff154008d2c1aba8d0005a8c90ef4938bffd03ebfb083a4e142acb0c73'),
  ('regional-novosibirskaia-oblast@layout-canonical-v2-46797381eed2-36ca087f9b14',556,'dba7ccf78ade3b04ed233708bf34fefe254dec655fa6b6b3bb6ce76fdd61940b'),
  ('regional-omskaia-oblast@layout-canonical-v2-fb2f9dd74db5-3d5a4d9cd952',903,'793c11c62518c02fcae6e4e04c39dcfbf5ef9ffff2676a207977c732c870467a'),
  ('regional-orenburgskaia-oblast@layout-canonical-v2-1deb0f3e21ee-6e2cac85b07e',543,'84fe69c0a3214a5ac7e6e7d9b8d1ae63b20edc69f48f5492eede26fe178cce01'),
  ('regional-orlovskaia-oblast@layout-canonical-v2-437d2a2c1a2f-69c53795bc55',587,'012fb694af10eff8fb9a4ac5741cb98c704d98df676b4a503d0ad864d7683963'),
  ('regional-penzenskaia-oblast@layout-canonical-v2-4ca13d0f5839-de77e5219e76',431,'1187b7c11d0102cdf545bc463ee4b0a0b857fee4f43f33b1eab15a9bfd213c81'),
  ('regional-permskii-krai@layout-canonical-v2-85765469982d-693fc00e8a7b',722,'71f2eb424a17535d64fa9007f4cb8d082c06704a6a0baafb441e96f679691bf8'),
  ('regional-primorskii-krai@layout-canonical-v2-1e8ceabd7305-d6ec0927691d',722,'e30ba640dbc19db824a9e6a01f0f95a96d5cdc2fc4f97cf9ecd57b8d60e8968a'),
  ('regional-pskovskaia-oblast@layout-canonical-v2-1bf50542e42d-b307aace1e21',193,'cf8c901a0ac5eee9b16f80ed6fac78f2b6b3dee4389a6454bb04e04b75f00acc'),
  ('regional-respublika-adygeia-adygeia@layout-canonical-v2-ace8b81a832b-00a8e1cc2802',665,'31aafe643400ac167f0e9fc43be90091683fad74053417c2d043edd5e02c5e99'),
  ('regional-respublika-bashkortostan@layout-canonical-v2-21423e5aa49f-1833088a0a00',514,'ee26dfd79825563d7d3ccd4492063d1190c8f0ba71cf2394564bd38e147a34b8'),
  ('regional-respublika-buriatiia@layout-canonical-v2-0e526ba86a43-85cc5471c1f7',613,'aa358ca71d3949d367c9311a8981522fdcc6838b8c01e00236208b6bd973802c'),
  ('regional-respublika-dagestan@layout-canonical-v2-7e0951e596d7-12305ca76c12',448,'5854d21eb2e9e47e3da46f665f3671c2640440dce73e7cd323e1937efe472378'),
  ('regional-respublika-ingushetiia@layout-canonical-v2-acd848186d7e-7938759488f5',349,'fb1b50d4b5a7153047f1da20c72889f487f04989073383b6075b36d367a3a76e'),
  ('regional-respublika-kalmykiia@layout-canonical-v2-e6236bc0fdef-cd2ae6c53842',435,'bdd8f5aff35fd12871c1027baa230448b49107a56179ebaa6af73468718763d4'),
  ('regional-respublika-kareliia@layout-canonical-v2-030113850eb7-7a8a57e218bf',542,'bbfcce708deffe7ca047fe7dd763e2472a2352a79ff864664a9cc0a2932164ce'),
  ('regional-respublika-komi@layout-canonical-v2-6891aa6efa7c-17d025f27823',2054,'7675414df6bacd3b9459d7d56f47b061f4e63fd74983176b0720d65112c49953'),
  ('regional-respublika-krym@layout-canonical-v2-30d38af868e9-183033652400',1168,'22b1d907e41f7448c9437e5dbc304a09cf71956a52d489821f48c2ed6bac7c81'),
  ('regional-respublika-marii-el@layout-canonical-v2-e7e100562e40-cbe64ec1a4df',269,'2675f410116b4dedb058b20ccef258daf7aa05cbc7997a05cb87c554b0548798'),
  ('regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5',1028,'4db98a7065c75e1854ccd0ba48278c34798d4cd183e0fcf6862d5c99b8fde292'),
  ('regional-respublika-sakha-iakutiia@layout-canonical-v2-6475eeaf1224-7d294dea488f',382,'93f20017949d06e56c5e203fd2fe30b8da7b64ed1ab6cdd083b75b8541f337a0'),
  ('regional-respublika-severnaia-osetiia-alaniia@layout-canonical-v2-83fbe48c92d4-5525eff89106',568,'070ea4edd8c0b4c05699a29e8864bb05782d2bf6cf8e3caa21a4eff0593f6824'),
  ('regional-respublika-tatarstan-tatarstan@layout-canonical-v2-3516754cd9d2-e92241cf9d75',932,'325a53f63b6c56b26c0d7c01f2e900d2ff7e146e753f78c9fa8dcf1d340eedb7'),
  ('regional-respublika-tyva@layout-canonical-v2-deea3dcd3921-912651d25baa',485,'7c896eacb7d9d9f29bd37fbb757e244d3c35dae5aa47b2c1384b9fc44e551885'),
  ('regional-respublika-khakasiia@layout-canonical-v2-facac2c9bf88-65b0833187aa',645,'1d71bc134b9bad57820c3a6830dc4ba77fa5354ff3e39c1207ae40a0405ee74f'),
  ('regional-rostovskaia-oblast@layout-canonical-v2-7b8f46e5a25f-373f53586db0',966,'4e6027b0245cf9ea49b887df6c97c5ea70c175ebfc24b5c04689c44b980fbd78'),
  ('regional-riazanskaia-oblast@layout-canonical-v2-c2317240ff7a-6fd4a56c6c1c',910,'191efb7163b7c86a05e2b6eeb12ea77a48b5a04bd7ba2922a27be60908b059a5'),
  ('regional-samarskaia-oblast@layout-canonical-v2-123f5c1e91a2-f803dc40ba08',909,'9bb8b3ebd4e7b0ee920d70ca546ed05abfb70e49824dae89890b47a3388f2150'),
  ('regional-sankt-peterburg@layout-canonical-v2-3b7e3a7e0805-3215227ae530',332,'3ee24d6304699c8d5f87f1b617044d82c5f23ace7c8ad2f08bc7f20415605db2'),
  ('regional-saratovskaia-oblast@layout-canonical-v2-66081ba320fc-f9be9f1b2097',506,'ca052eb75c13b859c5a0f97c3acf242c64c0bafc416a4ebf3a74168020a47361'),
  ('regional-sakhalinskaia-oblast@layout-canonical-v2-a1eff2fec702-95fe9bf1a33d',743,'4c6308a9d9b5e3689ed1881bf1d32a5fbea48441d58c55745be5f4b7ece376cd'),
  ('regional-sverdlovskaia-oblast@layout-canonical-v2-2d58636b133d-8b7c553d7c1a',567,'37ef536f70d748e60ec5e85a38fdcfc9f7d2dcfeff17fe1b386021203837ef96'),
  ('regional-sevastopol@layout-canonical-v2-7d6558c58b9e-226d12718f7e',205,'a512c5a35b9f12d45e2933b17b083b577b6395d273ae05dbc62c60e38af10299'),
  ('regional-smolenskaia-oblast@layout-canonical-v2-90de59cf3850-260928c26b73',790,'62753c491fc8949eb44036e77ed7064196045b530335bb74ad4fe1e7e7d5d06d'),
  ('regional-stavropolskii-krai@layout-canonical-v2-e72c39e23ee0-2e5402cc0aba',512,'7564fa2cc042fe7047cc6d343d400783801b310d46cdf86e121184041bb87bba'),
  ('regional-tambovskaia-oblast@layout-canonical-v2-92e794ebe2d5-0975d47a9058',923,'811ee0d6c2b07126cd1eca6a7da437bcc07ddec514e16b76baff69162c0b1878'),
  ('regional-tverskaia-oblast@layout-canonical-v2-c8f4a65e56f8-a456865e1043',482,'f1fb74019952e3e4fc54d2eff722ef88f5ea9b706fa669625d01b2a011f5fa1e'),
  ('regional-tomskaia-oblast@layout-canonical-v2-dc2ffe64bc18-6aa3ffb64f3e',383,'a6ed0487a387251ef3cdd2bb9f42bdaf672d8d2ca228ce00bc4c3d0af6cd3aa1'),
  ('regional-tulskaia-oblast@layout-canonical-v2-26c6a1537302-9cf453f7ad50',322,'e40834798e1513cd576d6db461619545adc42ed296bf8da1c34bb5de62b63ca3'),
  ('regional-tiumenskaia-oblast@layout-canonical-v2-01708fed2982-77ea97d717f5',624,'223732d7896eaa5f8aa300fa5c6a31e77ad2e6b0f0c44c0d7a9bbd2f606f1f99'),
  ('regional-udmurtskaia-respublika@layout-canonical-v2-89e73784e8e2-9605ad1e87f7',826,'d0a2a167fd3d291f5a023a2d42490f2757507c39377ab6b41101d5b1d1085b87'),
  ('regional-ulianovskaia-oblast@layout-canonical-v2-cb6b7173f8ae-1c46b3f522c3',42,'bd91b40f1ff7dee04d026e43a18490f32fbca9673c266c15a37124369cd4de2b'),
  ('regional-khabarovskii-krai@layout-canonical-v2-ede4767989bf-300bcbfa0b80',719,'ff0bdb1f8f430d584eccbefc723524e7e74974b2e810722f54ccc32c3cc80918'),
  ('regional-khanty-mansiiskii-avtonomnyi-okrug-iugra@layout-canonical-v2-781b6e9bbda6-fcb07ec2e2b5',70,'bd18ed3c102e2fd9e0637fc0e185e56dae91280eb097907f50857ce87da67698'),
  ('regional-cheliabinskaia-oblast@layout-canonical-v2-02d5a850ed5e-a05782f2a5a7',6,'8e6ced5b1e019b4a373fd2b7ffbb76a1ac68716d062ab90c76d91542fe977d3e'),
  ('regional-chechenskaia-respublika@layout-canonical-v2-def11b67eb81-c875c3885ee9',439,'838ffa4c39957455f458ec9d227c89a0eb7d2e84153316385f995b151d88da42'),
  ('regional-chuvashskaia-respublika-chuvashiia@layout-canonical-v2-0db2582d3448-c5cbfa1df5c0',2579,'90c2b14cfbe04f19fba191bfce10f6458c03e66ed17bc4cb395c27b07a9a372a'),
  ('regional-chukotskii-avtonomnyi-okrug@layout-canonical-v2-8db2b398f0fa-33cf5f1eb12f',757,'a403f8d0b129620f9dc057f976eaa31ba4a6a58cdddeaa033b09654216016d43'),
  ('regional-iamalo-nenetskii-avtonomnyi-okrug@layout-canonical-v2-5da24b311567-122dc3ce078f',1130,'ef1c0e24d10caa271e68380da23c958f2a551cef6d40c37ddc8e653e7adc61f0'),
  ('regional-iaroslavskaia-oblast@layout-canonical-v2-a61032c8e9ed-6593af44eea4',349,'e082be2724e6414d3f026948d0930b1ae3567000a0962494d49ac9b02eaa9fa2')
), observed as (
 select b.version_id,count(*)::integer as block_count,
 encode(sha256(convert_to(coalesce(string_agg(octet_length(b.block_id)::text||':'||b.block_id||'64:'||encode(sha256(convert_to(jsonb_build_object('block_id',b.block_id,'block_order',b.block_order,'kind',b.kind,'page_start',b.page_start,'page_end',b.page_end,'canonical_text',b.canonical_text)::text,'UTF8')),'hex'),'' order by b.block_id collate "C"),''),'UTF8')),'hex') as rows_sha256
 from private.source_blocks b group by b.version_id
)
select e.version_id,coalesce(v.sealed and v.block_count=e.block_count and o.block_count=e.block_count
 and o.rows_sha256=e.rows_sha256,false) as passed
from expected e left join private.source_versions v using(version_id)
left join observed o using(version_id) order by e.version_id;

-- 5. Immutable territorial release: sealed=true, 2471 / 12053, fixture=false.
select d.id,d.sealed,d.territory_count,d.series_count,
 (select count(*) from private.dw_roadmap_territories t where t.dataset_id=d.id) as actual_territories,
 (select count(*) from private.dw_roadmap_series s where s.dataset_id=d.id) as actual_series,
 d.metadata->>'indexSha256' as index_sha256,d.metadata->'fixture' as fixture
from private.dw_roadmap_datasets d;

-- 6. Full territorial JSONB records, including source catalog: passed=true.
select encode(sha256(convert_to(coalesce(string_agg(octet_length(t.territory_key)::text||':'||t.territory_key||'64:'||encode(sha256(convert_to(jsonb_build_object('territory_key',t.territory_key,'level',t.level,'region_id',t.region_id,'room_eligible',t.room_eligible,'material',t.material,'catalog_record',t.catalog_record)::text,'UTF8')),'hex'),'' order by t.territory_key collate "C"),''),'UTF8')),'hex')='4551a4abe2b29d4cf96e01bd7a7a7a8ff7c872c48a0a1baa1f2b7f8e1b346d5b' as passed
from private.dw_roadmap_territories t where t.dataset_id='territories-v1-rudn-08c68f1fe1c8-spd-59b778760c9e';

-- 7. Every statistical field and exact canonical text: passed=true.
select encode(sha256(convert_to(coalesce(string_agg(octet_length(s.id)::text||':'||s.id||'64:'||encode(sha256(convert_to(jsonb_build_object('id',s.id,'territory_key',s.territory_key,'fingerprint',s.fingerprint,'material',s.material,'canonical_text',s.canonical_text)::text,'UTF8')),'hex'),'' order by s.id collate "C"),''),'UTF8')),'hex')='c892e934ac731a185c397af7244e42913e9d8a6beb30d24d4acdb188e6d6617c' as passed
from private.dw_roadmap_series s where s.dataset_id='territories-v1-rudn-08c68f1fe1c8-spd-59b778760c9e';

-- 8. Tables without RLS. Expected zero rows.
select n.nspname,c.relname
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind in ('r','p') and (n.nspname in ('private','research')
 or (n.nspname='public' and c.relname like 'dw\_%' escape '\')) and not c.relrowsecurity;

-- 9. Public privileged functions or unfixed search_path. Expected zero rows.
select n.nspname,p.proname,p.prosecdef,p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname in ('private','research') or (n.nspname='public' and p.proname like 'dw\_%' escape '\'))
 and ((n.nspname='public' and p.prosecdef) or not coalesce('search_path=""'=any(p.proconfig),false));

-- 10. PUBLIC function execution grants. Expected zero rows.
select n.nspname,p.proname
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
where (n.nspname in ('private','research') or (n.nspname='public' and p.proname like 'dw\_%' escape '\'))
 and a.grantee=0 and a.privilege_type='EXECUTE';

-- 11. Exact anonymous surface: four entry RPCs plus four independent survey RPCs,
-- each with its public wrapper and private handler; authenticated also has EXECUTE.
-- Expected zero rows. Survey handlers keep their independent SURVEY_ANON_ONLY guard.
with methods(function_name,argument_types) as (values
 ('dw_identify','text, text'),('dw_entry_session','text'),('dw_entry_logout','text'),
 ('dw_entry_rpc','text, text, jsonb'),
 ('dw_survey_public_manifest','uuid, text'),('dw_survey_own_response','uuid, text'),
 ('dw_survey_save_response','uuid, uuid, text, text, jsonb'),
 ('dw_survey_withdraw_response','uuid, uuid, text, bigint')
), expected as (
 select schema_name,function_name,argument_types from methods cross join (values ('public'),('private')) n(schema_name)
), actual as (
 select n.nspname as schema_name,p.proname as function_name,oidvectortypes(p.proargtypes) as argument_types,
   has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
   has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.proname like 'dw\_%' escape '\'
)
select 'missing_or_incorrect_entry_grant' as problem,e.schema_name,e.function_name,e.argument_types
from expected e left join actual a using(schema_name,function_name,argument_types)
where not coalesce(a.anon_execute and a.authenticated_execute,false)
union all
select 'unexpected_anonymous_execute',a.schema_name,a.function_name,a.argument_types
from actual a where a.anon_execute and not exists(select 1 from expected e
 where e.schema_name=a.schema_name and e.function_name=a.function_name and e.argument_types=a.argument_types)
order by problem,schema_name,function_name;

-- 12. Direct table write/read leaks. Expected zero rows.
select n.nspname,c.relname,r.rolname
from pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join pg_roles r
where c.relkind in ('r','p') and r.rolname in ('anon','authenticated')
 and (n.nspname in ('private','research') or (n.nspname='public' and c.relname like 'dw\_%' escape '\'))
 and (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
 or ((n.nspname in ('private','research') or r.rolname='anon') and has_table_privilege(r.oid,c.oid,'SELECT')));

-- 13. Four independent event tables in Realtime. Every published=true.
with expected(tablename) as (values ('dw_session_events'),('dw_workshop_events'),('dw_barrier_events'),('dw_roadmap_events'))
select e.tablename,exists(select 1 from pg_publication_tables p where p.pubname='supabase_realtime'
 and p.schemaname='public' and p.tablename=e.tablename) as published
from expected e order by e.tablename;

-- 14. No private or research data in Realtime. Expected zero rows.
select pubname,schemaname,tablename from pg_publication_tables
where pubname='supabase_realtime' and schemaname in ('private','research');

-- 15. Provisioning counts only. No Auth mailbox confirmation is fabricated or required
-- for declared participants / protected operator actors; no personal identity is returned.
select count(*) filter(where f.revoked_at is null and a.disabled_at is null) as enabled_facilitators,
 count(*) filter(where f.revoked_at is null and a.disabled_at is null and a.kind='operator') as operator_facilitators,
 count(*) filter(where f.revoked_at is null and a.disabled_at is null and a.kind='auth') as legacy_auth_facilitators,
 count(*) filter(where f.revoked_at is null and a.disabled_at is null and a.kind='declared') as declared_facilitators
from private.facilitators f join private.dw_actors a on a.id=f.user_id;

-- 16. Exact application signatures compiled from the six shipped migrations.
-- Expected 226 signatures and zero missing, unexpected or overloaded definitions.
-- Catalog comparison only: none of these functions is invoked by this check.
with expected(schema_name,function_name,argument_types) as (values
 ('private','dw_actor_eligible','uuid'),
 ('private','dw_available_sessions',''),
 ('private','dw_ballot_period_guard',''),
 ('private','dw_barrier_evidence','uuid, uuid'),
 ('private','dw_barrier_evidence_immutable',''),
 ('private','dw_barrier_family_material','uuid, uuid'),
 ('private','dw_barrier_family_options','uuid'),
 ('private','dw_barrier_session_created',''),
 ('private','dw_barrier_touch','uuid, text'),
 ('private','dw_barrier_vote','uuid, uuid, jsonb'),
 ('private','dw_barrier_workshop_bridge',''),
 ('private','dw_barrier_write_guard','uuid, boolean'),
 ('private','dw_barriers_cursor','uuid'),
 ('private','dw_barriers_json','uuid, boolean'),
 ('private','dw_barriers_projector_snapshot','uuid'),
 ('private','dw_barriers_snapshot','uuid'),
 ('private','dw_begin_operation','uuid, text, jsonb'),
 ('private','dw_bootstrap',''),
 ('private','dw_can_read_profile','uuid'),
 ('private','dw_capture_roadmap_basis','uuid, uuid, jsonb'),
 ('private','dw_capture_roadmap_fact','uuid, uuid, jsonb'),
 ('private','dw_cast_vote','uuid, uuid, uuid, uuid, integer, bigint'),
 ('private','dw_cast_vote_updates','uuid, uuid, uuid, uuid, integer, bigint, uuid'),
 ('private','dw_close_voting_round','uuid, uuid, uuid, bigint'),
 ('private','dw_compact_workshop','jsonb, uuid'),
 ('private','dw_configure_roadmaps','uuid, uuid, jsonb'),
 ('private','dw_create_session','uuid, text, text, text'),
 ('private','dw_delete_family','uuid, uuid, uuid, bigint'),
 ('private','dw_entry_current_actor',''),
 ('private','dw_entry_dto','private.dw_entry_sessions, text'),
 ('private','dw_entry_hash','text'),
 ('private','dw_entry_logout','text'),
 ('private','dw_entry_mint','uuid, boolean'),
 ('private','dw_entry_rpc','text, text, jsonb'),
 ('private','dw_entry_session','text'),
 ('private','dw_entry_token','text'),
 ('private','dw_event','uuid, uuid, text, uuid, bigint'),
 ('private','dw_fail','text'),
 ('private','dw_family_list','uuid'),
 ('private','dw_finish_operation','uuid, text, jsonb, jsonb'),
 ('private','dw_freeze_roadmap','uuid, uuid, jsonb'),
 ('private','dw_id','jsonb'),
 ('private','dw_identify','text, text'),
 ('private','dw_invitation','uuid'),
 ('private','dw_is_verified',''),
 ('private','dw_issue_operator_session','text, uuid'),
 ('private','dw_join_open_session','uuid, uuid'),
 ('private','dw_join_roadmap','uuid, uuid, jsonb'),
 ('private','dw_join_session','uuid, text'),
 ('private','dw_keys','jsonb, text[]'),
 ('private','dw_manage_survey','uuid, uuid, jsonb'),
 ('private','dw_member_role','uuid'),
 ('private','dw_moderate_submission','uuid, uuid, uuid, bigint, text'),
 ('private','dw_normalize_email','text'),
 ('private','dw_open_voting_round','uuid, uuid, text, text, bigint, jsonb'),
 ('private','dw_projector_snapshot','uuid'),
 ('private','dw_publish_submission','uuid, uuid, text, bigint, jsonb'),
 ('private','dw_record_family_history','uuid, uuid'),
 ('private','dw_region_work','uuid, uuid, text, text, bigint, text'),
 ('private','dw_register_auth_actor',''),
 ('private','dw_review_roadmap','uuid, uuid, jsonb'),
 ('private','dw_revoke_member','uuid, uuid, uuid, bigint'),
 ('private','dw_roadmap_barrier_ground','uuid, uuid'),
 ('private','dw_roadmap_bases_json','uuid, uuid'),
 ('private','dw_roadmap_budget','uuid'),
 ('private','dw_roadmap_cost','jsonb'),
 ('private','dw_roadmap_dataset_immutable',''),
 ('private','dw_roadmap_ground','uuid, text, uuid'),
 ('private','dw_roadmap_items_json','uuid, boolean'),
 ('private','dw_roadmap_link_stale','uuid, uuid'),
 ('private','dw_roadmap_material_immutable',''),
 ('private','dw_roadmap_read_guard','uuid'),
 ('private','dw_roadmap_rooms_json','uuid'),
 ('private','dw_roadmap_series_json','uuid'),
 ('private','dw_roadmap_session_created',''),
 ('private','dw_roadmap_snapshot','uuid, uuid'),
 ('private','dw_roadmap_source_bridge',''),
 ('private','dw_roadmap_statistics_history','uuid, jsonb'),
 ('private','dw_roadmap_statistics_restore','uuid, uuid, jsonb'),
 ('private','dw_roadmap_statistics_save','uuid, uuid, jsonb'),
 ('private','dw_roadmap_statistics_series','uuid, jsonb'),
 ('private','dw_roadmap_touch','uuid, uuid, text, boolean'),
 ('private','dw_roadmap_validate_room','uuid'),
 ('private','dw_roadmap_version','uuid, uuid, uuid'),
 ('private','dw_roadmap_versions_json','uuid'),
 ('private','dw_roadmap_write_guard','uuid, uuid, boolean'),
 ('private','dw_roadmaps_cursor','uuid'),
 ('private','dw_roadmaps_index','uuid'),
 ('private','dw_roadmaps_projector_snapshot','uuid, uuid'),
 ('private','dw_rotate_invitation','uuid, uuid, bigint'),
 ('private','dw_round_json','uuid, boolean'),
 ('private','dw_round_material_immutable',''),
 ('private','dw_round_metadata_immutable',''),
 ('private','dw_round_source_guard',''),
 ('private','dw_round_summary','uuid'),
 ('private','dw_s4_digest','text, text'),
 ('private','dw_s4_integer','jsonb, bigint'),
 ('private','dw_s4_required','jsonb, text[]'),
 ('private','dw_s4_text','jsonb, integer, integer'),
 ('private','dw_s4_uuid','jsonb'),
 ('private','dw_s5_date','jsonb'),
 ('private','dw_s5_dates','jsonb'),
 ('private','dw_s5_domain','numeric, text'),
 ('private','dw_s5_ids','jsonb, integer'),
 ('private','dw_s5_item_limit','text'),
 ('private','dw_s5_number','jsonb'),
 ('private','dw_s5_series_array','jsonb'),
 ('private','dw_s5_validate_data','text, jsonb'),
 ('private','dw_s5_year','jsonb'),
 ('private','dw_s6_base_series','uuid, text'),
 ('private','dw_s6_definition','text'),
 ('private','dw_s6_heads_json','uuid'),
 ('private','dw_s6_immutable',''),
 ('private','dw_s6_metric','text'),
 ('private','dw_s6_required_text','jsonb, integer'),
 ('private','dw_s6_resolve_series','uuid, text, text'),
 ('private','dw_s6_value','text, jsonb'),
 ('private','dw_s8_trim','text'),
 ('private','dw_save_barrier','uuid, uuid, jsonb'),
 ('private','dw_save_barrier_link','uuid, uuid, jsonb'),
 ('private','dw_save_family','uuid, uuid, uuid, bigint, text, text, text, uuid[]'),
 ('private','dw_save_profile','uuid, bigint, text'),
 ('private','dw_save_roadmap_item','uuid, uuid, jsonb'),
 ('private','dw_save_solution','uuid, uuid, jsonb'),
 ('private','dw_save_survey','uuid, uuid, jsonb'),
 ('private','dw_session_cursor','uuid'),
 ('private','dw_session_json','uuid'),
 ('private','dw_set_member_role','uuid, uuid, uuid, bigint, text'),
 ('private','dw_snapshot','uuid'),
 ('private','dw_source_immutable',''),
 ('private','dw_survey_anon_guard',''),
 ('private','dw_survey_blank_answers',''),
 ('private','dw_survey_check_secret','text'),
 ('private','dw_survey_export_missing','jsonb'),
 ('private','dw_survey_host_state','uuid, uuid'),
 ('private','dw_survey_invitation_state','uuid, uuid'),
 ('private','dw_survey_manifest_json','uuid'),
 ('private','dw_survey_own_json','uuid, text'),
 ('private','dw_survey_own_response','uuid, text'),
 ('private','dw_survey_public_manifest','uuid, text'),
 ('private','dw_survey_research_export','uuid, uuid'),
 ('private','dw_survey_save_response','uuid, uuid, text, text, jsonb'),
 ('private','dw_survey_summary_json','uuid'),
 ('private','dw_survey_validate_answers','jsonb'),
 ('private','dw_survey_withdraw_response','uuid, uuid, text, bigint'),
 ('private','dw_text','jsonb, integer, integer'),
 ('private','dw_update_session','uuid, uuid, bigint, jsonb'),
 ('private','dw_validate_bundle','jsonb'),
 ('private','dw_verified_uid',''),
 ('private','dw_workshop_cursor','uuid'),
 ('private','dw_workshop_member_changed',''),
 ('private','dw_workshop_profile_changed',''),
 ('private','dw_workshop_projector_snapshot','uuid'),
 ('private','dw_workshop_projector_updates','uuid, uuid'),
 ('private','dw_workshop_round_snapshot','uuid, uuid'),
 ('private','dw_workshop_session_changed',''),
 ('private','dw_workshop_snapshot','uuid'),
 ('private','dw_workshop_source_changed',''),
 ('private','dw_workshop_touch','uuid, text, boolean'),
 ('private','dw_workshop_updates','uuid, uuid'),
 ('public','dw_available_sessions',''),
 ('public','dw_barrier_evidence','uuid, uuid'),
 ('public','dw_barrier_vote','uuid, uuid, jsonb'),
 ('public','dw_barriers_cursor','uuid'),
 ('public','dw_barriers_projector_snapshot','uuid'),
 ('public','dw_barriers_snapshot','uuid'),
 ('public','dw_bootstrap',''),
 ('public','dw_capture_roadmap_basis','uuid, uuid, jsonb'),
 ('public','dw_capture_roadmap_fact','uuid, uuid, jsonb'),
 ('public','dw_cast_vote','uuid, uuid, uuid, uuid, integer, bigint'),
 ('public','dw_cast_vote_updates','uuid, uuid, uuid, uuid, integer, bigint, uuid'),
 ('public','dw_close_voting_round','uuid, uuid, uuid, bigint'),
 ('public','dw_configure_roadmaps','uuid, uuid, jsonb'),
 ('public','dw_create_session','uuid, text, text, text'),
 ('public','dw_delete_family','uuid, uuid, uuid, bigint'),
 ('public','dw_entry_logout','text'),
 ('public','dw_entry_rpc','text, text, jsonb'),
 ('public','dw_entry_session','text'),
 ('public','dw_freeze_roadmap','uuid, uuid, jsonb'),
 ('public','dw_identify','text, text'),
 ('public','dw_invitation','uuid'),
 ('public','dw_join_open_session','uuid, uuid'),
 ('public','dw_join_roadmap','uuid, uuid, jsonb'),
 ('public','dw_join_session','uuid, text'),
 ('public','dw_manage_survey','uuid, uuid, jsonb'),
 ('public','dw_moderate_submission','uuid, uuid, uuid, bigint, text'),
 ('public','dw_open_voting_round','uuid, uuid, text, text, bigint, jsonb'),
 ('public','dw_projector_snapshot','uuid'),
 ('public','dw_publish_submission','uuid, uuid, text, bigint, jsonb'),
 ('public','dw_region_work','uuid, uuid, text, text, bigint, text'),
 ('public','dw_review_roadmap','uuid, uuid, jsonb'),
 ('public','dw_revoke_member','uuid, uuid, uuid, bigint'),
 ('public','dw_roadmap_snapshot','uuid, uuid'),
 ('public','dw_roadmap_statistics_history','uuid, jsonb'),
 ('public','dw_roadmap_statistics_restore','uuid, uuid, jsonb'),
 ('public','dw_roadmap_statistics_save','uuid, uuid, jsonb'),
 ('public','dw_roadmap_statistics_series','uuid, jsonb'),
 ('public','dw_roadmap_version','uuid, uuid, uuid'),
 ('public','dw_roadmaps_cursor','uuid'),
 ('public','dw_roadmaps_index','uuid'),
 ('public','dw_roadmaps_projector_snapshot','uuid, uuid'),
 ('public','dw_rotate_invitation','uuid, uuid, bigint'),
 ('public','dw_save_barrier','uuid, uuid, jsonb'),
 ('public','dw_save_barrier_link','uuid, uuid, jsonb'),
 ('public','dw_save_family','uuid, uuid, uuid, bigint, text, text, text, uuid[]'),
 ('public','dw_save_profile','uuid, bigint, text'),
 ('public','dw_save_roadmap_item','uuid, uuid, jsonb'),
 ('public','dw_save_solution','uuid, uuid, jsonb'),
 ('public','dw_save_survey','uuid, uuid, jsonb'),
 ('public','dw_session_cursor','uuid'),
 ('public','dw_session_snapshot','uuid'),
 ('public','dw_set_member_role','uuid, uuid, uuid, bigint, text'),
 ('public','dw_survey_host_state','uuid, uuid'),
 ('public','dw_survey_invitation_state','uuid, uuid'),
 ('public','dw_survey_own_response','uuid, text'),
 ('public','dw_survey_public_manifest','uuid, text'),
 ('public','dw_survey_research_export','uuid, uuid'),
 ('public','dw_survey_save_response','uuid, uuid, text, text, jsonb'),
 ('public','dw_survey_withdraw_response','uuid, uuid, text, bigint'),
 ('public','dw_update_session','uuid, uuid, bigint, jsonb'),
 ('public','dw_workshop_cursor','uuid'),
 ('public','dw_workshop_projector_snapshot','uuid'),
 ('public','dw_workshop_projector_updates','uuid, uuid'),
 ('public','dw_workshop_round_snapshot','uuid, uuid'),
 ('public','dw_workshop_snapshot','uuid'),
 ('public','dw_workshop_updates','uuid, uuid')
), actual as (
 select n.nspname as schema_name,p.proname as function_name,oidvectortypes(p.proargtypes) as argument_types
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.proname like 'dw\_%' escape '\'
)
select 'missing_signature' as problem,e.schema_name,e.function_name,e.argument_types
from expected e where not exists(select 1 from actual a where a.schema_name=e.schema_name
 and a.function_name=e.function_name and a.argument_types=e.argument_types)
union all
select 'unexpected_signature',a.schema_name,a.function_name,a.argument_types
from actual a where not exists(select 1 from expected e where e.schema_name=a.schema_name
 and e.function_name=a.function_name and e.argument_types=a.argument_types)
order by problem,schema_name,function_name,argument_types;

-- 17. Three identity tables must exist with RLS and no client table privileges.
-- Expected zero rows; these checks do not read any identity or token values.
with expected(table_name) as (values ('dw_actors'),('dw_declared_identities'),('dw_entry_sessions'))
select e.table_name from expected e
left join pg_namespace n on n.nspname='private'
left join pg_class c on c.relnamespace=n.oid and c.relname=e.table_name and c.relkind='r'
where c.oid is null or not c.relrowsecurity
 or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE');

-- 18. Internal identity helpers and the owner-only operator issuer are never client RPCs.
-- Expected zero rows. The issuer is inspected through pg_proc; it is not executed.
with expected(signature) as (values
 ('private.dw_issue_operator_session(text,uuid)'),('private.dw_register_auth_actor()'),
 ('private.dw_s8_trim(text)'),('private.dw_normalize_email(text)'),('private.dw_entry_hash(text)'),
 ('private.dw_entry_token(text)'),('private.dw_entry_current_actor()'),('private.dw_actor_eligible(uuid)'),
 ('private.dw_entry_dto(private.dw_entry_sessions,text)'),('private.dw_entry_mint(uuid,boolean)')
)
select signature from expected where to_regprocedure(signature) is null
 or has_function_privilege('anon',to_regprocedure(signature),'EXECUTE')
 or has_function_privilege('authenticated',to_regprocedure(signature),'EXECUTE');

-- 19. Six historical references and two new references point to the actor registry.
-- Original delete actions remain CASCADE=c or NO ACTION=a; expected zero rows.
with expected(schema_name,table_name,column_name,delete_action) as (values
 ('private','facilitators','user_id','c'),('public','dw_profiles','user_id','c'),
 ('public','dw_sessions','owner_id','a'),('private','join_attempts','user_id','c'),
 ('private','command_receipts','actor_id','a'),('private','audit_events','actor_id','a'),
 ('private','dw_declared_identities','actor_id','a'),('private','dw_entry_sessions','actor_id','a')
)
select e.* from expected e where not exists(
 select 1 from pg_constraint fk join pg_class t on t.oid=fk.conrelid
 join pg_namespace n on n.oid=t.relnamespace
 join pg_attribute a on a.attrelid=t.oid and a.attnum=fk.conkey[1]
 where fk.contype='f' and cardinality(fk.conkey)=1 and fk.confrelid='private.dw_actors'::regclass
 and n.nspname=e.schema_name and t.relname=e.table_name and a.attname=e.column_name
 and fk.confdeltype::text=e.delete_action);

-- 20. Future Auth rows receive an actor through the enabled insert trigger.
-- Expected registered_trigger=true; catalog inspection only, no Auth insertion.
select exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
 join pg_namespace n on n.oid=p.pronamespace
 where t.tgrelid='auth.users'::regclass and t.tgname='dw_register_auth_actor'
 and not t.tgisinternal and t.tgenabled in ('O','A') and (t.tgtype::integer & 4)=4
 and n.nspname='private' and p.proname='dw_register_auth_actor') as registered_trigger;

-- 21. Invoker wrappers require only USAGE on private, never CREATE.
-- Expected zero rows. Research remains a closed schema, accessed by guarded definers.
with expected(role_name,schema_name,usage_allowed) as (values
 ('anon','private',true),('authenticated','private',true),
 ('anon','research',false),('authenticated','research',false)
)
select * from expected where has_schema_privilege(role_name,schema_name,'USAGE') is distinct from usage_allowed
 or has_schema_privilege(role_name,schema_name,'CREATE');
