import { TEAM_MAPPING } from './data.mjs';
import { fetchJson, ProviderError } from './http.mjs';
import { enrichTennisUpcomingAvailability } from './tennis.mjs';
const API_FOOTBALL_BASE=(process.env.API_FOOTBALL_BASE||'https://v3.football.api-sports.io').replace(/\/$/,'');const ODDS_API_BASE=(process.env.ODDS_API_BASE||'https://api.the-odds-api.com/v4').replace(/\/$/,'');const teamIdCache=new Map(),liveFootballCache=new Map(),fifaCurrentSeasonCache=new Map();let apiFootballSeasonRangeCache=null;
export function liveDataEnabled(){return !['0','false','no','off'].includes(String(process.env.LIVE_DATA_ENABLED||'true').toLowerCase());}
export function normName(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');}
export function getOddsTeamName(sport,team){return TEAM_MAPPING?.[sport]?.[team]?.odds_name||team;}
export function getOddsSportKey(sport,a,b){const env={cz_football:'ODDS_SPORT_CZ_FOOTBALL',fifa:'ODDS_SPORT_FIFA',nba:'ODDS_SPORT_NBA',nhl:'ODDS_SPORT_NHL'};if(process.env[env[sport]])return process.env[env[sport]];if(sport==='nba')return'basketball_nba';if(sport==='nhl')return'icehockey_nhl';if(sport==='fifa'){const x=TEAM_MAPPING?.fifa?.[a]?.odds_sport_key,y=TEAM_MAPPING?.fifa?.[b]?.odds_sport_key;return x&&x===y?x:null;}return null;}
function formatApiFootballErrors(errors){
  if(!errors)return'Neznámá chyba.';
  if(Array.isArray(errors))return errors.map(v=>String(v)).filter(Boolean).join(' | ')||'Neznámá chyba.';
  if(typeof errors==='object')return Object.entries(errors).map(([k,v])=>`${k}: ${String(v)}`).join(' | ')||'Neznámá chyba.';
  return String(errors);
}
export async function apiFootball(endpoint,params={}){
  const key=process.env.API_FOOTBALL_KEY;
  if(!key)throw new ProviderError('Chybí API_FOOTBALL_KEY v Netlify environment variables.',{status:503,code:'MISSING_KEY'});
  const url=new URL(`${API_FOOTBALL_BASE}/${String(endpoint).replace(/^\//,'')}`);
  for(const[k,v]of Object.entries(params))url.searchParams.set(k,String(v));
  const{data}=await fetchJson(url,{headers:{'x-apisports-key':key}},'API-Football');
  if(data?.errors&&Object.keys(data.errors).length){
    throw new ProviderError(`API-Football: ${formatApiFootballErrors(data.errors)}`,{status:502,code:'API_FOOTBALL_ERROR'});
  }
  return data;
}
export async function resolveApiFootballTeamId(sport,team){const ck=`${sport}:${team}`;if(teamIdCache.has(ck))return teamIdCache.get(ck);const search=TEAM_MAPPING?.[sport]?.[team]?.api_football_search||team,p=await apiFootball('teams',{search}),rows=p?.response||[];if(!rows.length)throw new ProviderError(`API-Football nenašel tým '${team}'.`,{status:404,code:'TEAM_NOT_FOUND'});const exact=rows.find(r=>String(r?.team?.name||'').toLowerCase()===search.toLowerCase()),id=Number((exact||rows[0])?.team?.id);teamIdCache.set(ck,id);return id;}
function inferFootballSeason(sport,team,date=new Date()){
  const override=globalThis.Netlify?.env?.get?.('API_FOOTBALL_SEASON');
  if(override&&/^\d{4}$/.test(String(override)))return Number(override);
  const year=date.getUTCFullYear(),month=date.getUTCMonth()+1;
  const nationalTeams=new Set(['France','Spain','Germany','Argentina','Czechia']);
  if(sport==='fifa'&&nationalTeams.has(team))return year;
  return month>=7?year:year-1;
}

async function fetchTeamSeasonFixtures(id,season){
  return apiFootball('fixtures',{team:id,season,status:'FT-AET-PEN'});
}

function parseAllowedSeasonRange(error){
  const match=String(error?.message||'').match(/try\s+from\s+(\d{4})\s+to\s+(\d{4})/i);
  if(!match)return null;
  return {min:Number(match[1]),max:Number(match[2])};
}

async function resolveAccessibleSeasonCandidates(id,currentSeason,wanted){
  let range=apiFootballSeasonRangeCache;
  if(range){
    return {
      seasons:[range.max,range.max-1].filter(s=>s>=range.min),
      historical:range.max<currentSeason,
      allowed_range:range
    };
  }

  try{
    const p=await fetchTeamSeasonFixtures(id,currentSeason);
    const completed=(p?.response||[]).filter(item=>item?.goals?.home!=null&&item?.goals?.away!=null).length;
    return {
      seasons:completed>=wanted?[currentSeason]:[currentSeason,currentSeason-1],
      historical:false,
      allowed_range:null,
      first_payload:p
    };
  }catch(error){
    range=parseAllowedSeasonRange(error);
    if(!range)throw error;
    apiFootballSeasonRangeCache=range;
    return {
      seasons:[range.max,range.max-1].filter(s=>s>=range.min),
      historical:true,
      allowed_range:range
    };
  }
}

export async function loadLiveFootballTeamData(sport,team,fallback){
  const ck=`${sport}:${team}`;
  if(liveFootballCache.has(ck))return liveFootballCache.get(ck);

  const id=await resolveApiFootballTeamId(sport,team);
  const recentRaw=globalThis.Netlify?.env?.get?.('API_FOOTBALL_RECENT_MATCHES');
  const wanted=Math.max(3,Number(recentRaw||10));
  const currentSeason=inferFootballSeason(sport,team);
  const access=await resolveAccessibleSeasonCandidates(id,currentSeason,wanted);
  const rows=[];
  const fetchedSeasons=[];

  if(access.first_payload){
    rows.push(...(access.first_payload?.response||[]));
    fetchedSeasons.push(currentSeason);
  }

  for(const season of access.seasons){
    if(access.first_payload&&season===currentSeason)continue;
    const p=await fetchTeamSeasonFixtures(id,season);
    rows.push(...(p?.response||[]));
    fetchedSeasons.push(season);
    const completed=rows.filter(item=>item?.goals?.home!=null&&item?.goals?.away!=null).length;
    if(completed>=wanted)break;
  }

  rows.sort((x,y)=>{
    const xd=Date.parse(x?.fixture?.date||0);
    const yd=Date.parse(y?.fixture?.date||0);
    return yd-xd;
  });

  const scored=[],conceded=[],usedFixtureDates=[];
  for(const item of rows){
    if(scored.length>=wanted)break;
    const h=item?.teams?.home?.id,a=item?.teams?.away?.id,hg=item?.goals?.home,ag=item?.goals?.away;
    if(hg==null||ag==null)continue;
    const fixtureDate=item?.fixture?.date||null;
    if(h===id){
      scored.push(Number(hg));
      conceded.push(Number(ag));
      if(fixtureDate)usedFixtureDates.push(fixtureDate);
    }else if(a===id){
      scored.push(Number(ag));
      conceded.push(Number(hg));
      if(fixtureDate)usedFixtureDates.push(fixtureDate);
    }
  }

  if(scored.length<3)throw new ProviderError(
    `Málo dokončených zápasů pro '${team}' v dostupných sezonách ${(fetchedSeasons.length?fetchedSeasons:access.seasons).join(' a ')}.`,
    {status:422,code:'NOT_ENOUGH_MATCHES'}
  );

  const avg=x=>x.reduce((a,b)=>a+b,0)/x.length;
  const validDates=usedFixtureDates
    .map(value=>({value,time:Date.parse(value)}))
    .filter(item=>Number.isFinite(item.time))
    .sort((a,b)=>a.time-b.time);
  const historicalRange=validDates.length?{
    from:validDates[0].value,
    to:validDates[validDates.length-1].value
  }:null;
  const r={
    attack:avg(scored),
    defense:avg(conceded),
    home_adv:fallback.home_adv||.12,
    matches_used:scored.length,
    historical_match_range:historicalRange,
    seasons_used:fetchedSeasons.length?fetchedSeasons:access.seasons,
    source_mode:access.historical?'api-football-historical':'api-football-live',
    allowed_season_range:access.allowed_range
  };
  liveFootballCache.set(ck,r);
  return r;
}


function isCalendarFifaCompetition(fixture){
  const key=String(fixture?.sport_key||'').toLowerCase();
  return (
    key.includes('fifa_world_cup')||
    key.includes('uefa_euro')||
    key.includes('world_cup_qual')
  );
}

export function fifaSeasonForFixture(fixtureOrDate){
  const fixture=typeof fixtureOrDate==='object'&&fixtureOrDate!==null
    ? fixtureOrDate
    : {commence_time:fixtureOrDate};
  const date=new Date(fixture?.commence_time||fixture?.date||Date.now());
  const year=date.getUTCFullYear();
  const month=date.getUTCMonth()+1;

  if(isCalendarFifaCompetition(fixture))return year;
  return month>=7?year:year-1;
}

export function fifaSeasonLabelForFixture(season,fixture){
  const value=Number(season);
  if(!Number.isFinite(value))return null;
  if(isCalendarFifaCompetition(fixture))return String(value);
  return `${value}/${String(value+1).slice(-2)}`;
}

export function classifyFifaDataAvailability(homeGames,awayGames){
  const home=Number(homeGames);
  const away=Number(awayGames);
  const valid=Number.isFinite(home)&&Number.isFinite(away);
  const minimum=valid?Math.min(home,away):0;

  if(!valid||minimum<3){
    return {
      analysis_available:false,
      data_status:'NEDOSTATEK DAT',
      reliability_status:'NEDOSTATEK DAT',
      minimum_completed_games:valid?minimum:null
    };
  }
  if(minimum<10){
    return {
      analysis_available:true,
      data_status:'OMEZENÁ SPOLEHLIVOST',
      reliability_status:'OMEZENÁ SPOLEHLIVOST',
      minimum_completed_games:minimum
    };
  }
  return {
    analysis_available:true,
    data_status:'PŘIPRAVENO',
    reliability_status:'STANDARDNÍ SPOLEHLIVOST',
    minimum_completed_games:minimum
  };
}

async function fifaCurrentSeasonGames(teamName,selectedFixture,wanted=10){
  const season=fifaSeasonForFixture(selectedFixture);
  const cacheKey=`${normName(teamName)}:${season}:${String(selectedFixture?.commence_time||'').slice(0,10)}`;
  const cached=fifaCurrentSeasonCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.value;

  if(apiFootballSeasonRangeCache&&season>apiFootballSeasonRangeCache.max){
    throw new ProviderError(
      `API-Football free plán neposkytuje sezonu ${season}; dostupné jsou sezony ${apiFootballSeasonRangeCache.min}-${apiFootballSeasonRangeCache.max}. Starší sezonu model pro FIFA/UEFA nepoužije.`,
      {status:422,code:'FIFA_CURRENT_SEASON_UNAVAILABLE'}
    );
  }

  const id=await resolveApiFootballTeamId('fifa',teamName);
  let payload;
  try{
    payload=await fetchTeamSeasonFixtures(id,season);
  }catch(error){
    const range=parseAllowedSeasonRange(error);
    if(range){
      apiFootballSeasonRangeCache=range;
      if(season>range.max){
        throw new ProviderError(
          `API-Football free plán neposkytuje sezonu ${season}; dostupné jsou sezony ${range.min}-${range.max}. Starší sezonu model pro FIFA/UEFA nepoužije.`,
          {status:422,code:'FIFA_CURRENT_SEASON_UNAVAILABLE'}
        );
      }
    }
    throw error;
  }

  const targetTime=Date.parse(selectedFixture?.commence_time||new Date().toISOString());
  const rows=(payload?.response||[])
    .filter(item=>{
      const when=Date.parse(item?.fixture?.date||0);
      const hg=item?.goals?.home,ag=item?.goals?.away;
      return Number.isFinite(when)&&when<targetTime&&hg!=null&&ag!=null;
    })
    .sort((a,b)=>Date.parse(b?.fixture?.date||0)-Date.parse(a?.fixture?.date||0));

  const allGames=[];
  for(const item of rows){
    const h=Number(item?.teams?.home?.id);
    const a=Number(item?.teams?.away?.id);
    const hg=Number(item?.goals?.home);
    const ag=Number(item?.goals?.away);
    if(h===id){
      allGames.push({
        date:item?.fixture?.date||null,
        home_away:'home',
        goals_for:hg,
        goals_against:ag,
        won:hg>ag,
        draw:hg===ag
      });
    }else if(a===id){
      allGames.push({
        date:item?.fixture?.date||null,
        home_away:'away',
        goals_for:ag,
        goals_against:hg,
        won:ag>hg,
        draw:hg===ag
      });
    }
  }

  const result={
    team_id:id,
    season,
    season_label:fifaSeasonLabelForFixture(season,selectedFixture),
    completed_games_total:allGames.length,
    games:allGames.slice(0,wanted)
  };
  fifaCurrentSeasonCache.set(cacheKey,{value:result,expires:Date.now()+30*60*1000});
  return result;
}

function footballForm(games,location){
  const rows=games.filter(game=>game.home_away===location);
  if(!rows.length)return {
    games:0,wins:0,draws:0,losses:0,gfpg:null,gapg:null
  };
  const wins=rows.filter(game=>game.won).length;
  const draws=rows.filter(game=>game.draw).length;
  return {
    games:rows.length,
    wins,
    draws,
    losses:rows.length-wins-draws,
    gfpg:Number((rows.reduce((sum,g)=>sum+g.goals_for,0)/rows.length).toFixed(2)),
    gapg:Number((rows.reduce((sum,g)=>sum+g.goals_against,0)/rows.length).toFixed(2))
  };
}

export async function loadFifaTeamCurrentSeasonData(teamName,selectedFixture,wanted=10){
  const seasonData=await fifaCurrentSeasonGames(teamName,selectedFixture,wanted);
  const games=seasonData.games;

  if(games.length<3){
    throw new ProviderError(
      `V aktuální sezoně ${seasonData.season_label} jsou před vybraným utkáním jen ${games.length} dokončené zápasy týmu ${teamName}. Model vyžaduje alespoň 3 a starší sezonu nepoužívá.`,
      {status:422,code:'FIFA_CURRENT_SEASON_TOO_FEW_GAMES'}
    );
  }

  const avg=values=>values.reduce((sum,v)=>sum+v,0)/values.length;
  const dates=games.map(game=>({value:game.date,time:Date.parse(game.date||0)}))
    .filter(item=>Number.isFinite(item.time))
    .sort((a,b)=>a.time-b.time);

  return {
    attack:avg(games.map(game=>game.goals_for)),
    defense:avg(games.map(game=>game.goals_against)),
    home_adv:0.1,
    matches_used:games.length,
    historical_match_range:dates.length?{
      from:dates[0].value,
      to:dates[dates.length-1].value
    }:null,
    seasons_used:[seasonData.season],
    season_label:seasonData.season_label,
    current_season_only:true,
    sample_complete:games.length>=10,
    home_form:footballForm(games,'home'),
    away_form:footballForm(games,'away'),
    source_mode:'api-football-current-season'
  };
}

async function enrichFifaUpcomingAvailability(events){
  const enriched=await Promise.all(events.map(async event=>{
    try{
      const [home,away]=await Promise.all([
        fifaCurrentSeasonGames(event.home_team,event,10),
        fifaCurrentSeasonGames(event.away_team,event,10)
      ]);
      const status=classifyFifaDataAvailability(
        home.completed_games_total,
        away.completed_games_total
      );
      return {
        ...event,
        ...status,
        fifa_season_label:home.season_label||away.season_label||null,
        current_season_games:{
          home:home.completed_games_total,
          away:away.completed_games_total
        }
      };
    }catch(error){
      console.warn('FIFA/UEFA upcoming availability check failed:',error.message);
      return {
        ...event,
        analysis_available:false,
        data_status:'NEDOSTATEK DAT',
        reliability_status:'NEDOSTATEK DAT',
        minimum_completed_games:null,
        current_season_games:{home:null,away:null},
        availability_error:error.message,
        availability_code:error.code||'FIFA_DATA_UNAVAILABLE'
      };
    }
  }));
  return enriched;
}

export function summarizeApiFootballMatchWinner(payload){
  const home=[],draw=[],away=[];
  let bookmakers=0;
  for(const row of payload?.response||[]){
    for(const bookmaker of row?.bookmakers||[]){
      let used=false;
      for(const bet of bookmaker?.bets||[]){
        if(Number(bet?.id)!==1&&normName(bet?.name)!=='matchwinner')continue;
        for(const value of bet?.values||[]){
          const odd=Number(value?.odd);
          if(!Number.isFinite(odd)||odd<=1)continue;
          const key=normName(value?.value);
          if(key==='home'){home.push(odd);used=true;}
          else if(key==='draw'){draw.push(odd);used=true;}
          else if(key==='away'){away.push(odd);used=true;}
        }
      }
      if(used)bookmakers+=1;
    }
  }
  const avg=values=>values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(3)):null;
  return {home:avg(home),draw:avg(draw),away:avg(away),bookmakers};
}

export async function loadApiFootballCzOdds(teamA,teamB,selectedFixture=null){
  const [idA,idB]=await Promise.all([
    resolveApiFootballTeamId('cz_football',teamA),
    resolveApiFootballTeamId('cz_football',teamB)
  ]);

  let exact=null;
  if(selectedFixture?.fixture_id){
    exact={
      fixture:{
        id:Number(selectedFixture.fixture_id),
        date:selectedFixture.commence_time||null,
        status:{short:'NS'}
      },
      teams:{
        home:{id:idA,name:teamA},
        away:{id:idB,name:teamB}
      },
      league:{
        id:selectedFixture.league_id||null,
        name:selectedFixture.league||null,
        country:selectedFixture.country||null
      }
    };
  }else{
    const h2h=await apiFootball('fixtures/headtohead',{h2h:`${idA}-${idB}`});
    const now=Date.now();
    const future=(h2h?.response||[])
      .filter(item=>{
        const when=Date.parse(item?.fixture?.date||0);
        const status=String(item?.fixture?.status?.short||'');
        return when>=now&&['NS','TBD'].includes(status);
      })
      .sort((x,y)=>Date.parse(x?.fixture?.date||0)-Date.parse(y?.fixture?.date||0));

    exact=future.find(item=>Number(item?.teams?.home?.id)===idA&&Number(item?.teams?.away?.id)===idB);
    if(!exact){
      const reverse=future.find(item=>Number(item?.teams?.home?.id)===idB&&Number(item?.teams?.away?.id)===idA);
      if(reverse){
        throw new ProviderError(
          `Nejbližší vzájemný zápas má opačné pořadí domácí/hosté: ${teamB} vs ${teamA}. Pro model vyber domácí tým jako Tým A.`,
          {status:422,code:'HOME_AWAY_MISMATCH'}
        );
      }
      throw new ProviderError(
        `API-Football nenašlo nadcházející zápas ${teamA} vs ${teamB} s dostupným fixture ID.`,
        {status:404,code:'EVENT_NOT_FOUND'}
      );
    }
  }

  const fixtureId=Number(exact?.fixture?.id);
  if(!fixtureId)throw new ProviderError('Nadcházející zápas nemá fixture ID.',{status:502,code:'MISSING_FIXTURE_ID'});

  const payload=await apiFootball('odds',{fixture:fixtureId,bet:1});
  const summary=summarizeApiFootballMatchWinner(payload);
  if(!(summary.home&&summary.draw&&summary.away)){
    const error=new ProviderError(
      'API-Football pro tento zápas zatím neposkytuje kompletní 1X2 pre-match kurzy.',
      {status:404,code:'ODDS_NOT_AVAILABLE'}
    );
    error.fixtureMeta={
      fixture_id:fixtureId,
      commence_time:exact?.fixture?.date||null,
      provider:'API-Football'
    };
    throw error;
  }

  return {
    home:summary.home,
    draw:summary.draw,
    away:summary.away,
    bookmakers:summary.bookmakers,
    fixture_id:fixtureId,
    commence_time:exact?.fixture?.date||null,
    provider:'API-Football'
  };
}


const upcomingCache=new Map();

function cacheGet(key){
  const item=upcomingCache.get(key);
  if(!item||item.expires<=Date.now())return null;
  return item.value;
}

function cacheSet(key,value,ttlMs=5*60*1000){
  upcomingCache.set(key,{value,expires:Date.now()+ttlMs});
  return value;
}

function eventTime(value){
  const time=Date.parse(value||0);
  return Number.isFinite(time)?time:0;
}

function normalizeUpcomingEvent(item,provider,sportKey=null){
  const fixtureId=item?.fixture?.id??null;
  const home=item?.teams?.home?.name??item?.home_team??null;
  const away=item?.teams?.away?.name??item?.away_team??null;
  const commence=item?.fixture?.date??item?.commence_time??null;
  if(!home||!away||!commence)return null;
  return {
    id:provider==='api-football'?String(fixtureId):String(item?.id||''),
    provider,
    fixture_id:provider==='api-football'?Number(fixtureId):null,
    event_id:provider==='the-odds-api'?String(item?.id||''):null,
    sport_key:sportKey||item?.sport_key||null,
    commence_time:commence,
    home_team:home,
    away_team:away,
    league_id:item?.league?.id??null,
    league:item?.league?.name??item?.sport_title??null,
    country:item?.league?.country??null,
    venue:item?.fixture?.venue?.name??null
  };
}

function utcDateOffset(days){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

function czFootballSeasonStart(date=new Date()){
  const year=date.getUTCFullYear();
  return date.getUTCMonth()+1>=7?year:year-1;
}

async function listCzFootballViaHeadToHead(leagueId){
  const names=Object.keys(TEAM_MAPPING?.cz_football||{});
  const pairs=[];
  for(let i=0;i<names.length;i+=1){
    for(let j=i+1;j<names.length;j+=1)pairs.push([names[i],names[j]]);
  }

  const ids=new Map();
  for(const name of names){
    ids.set(name,await resolveApiFootballTeamId('cz_football',name));
  }

  const settled=await Promise.allSettled(pairs.map(async([a,b])=>{
    const payload=await apiFootball('fixtures/headtohead',{h2h:`${ids.get(a)}-${ids.get(b)}`});
    return payload?.response||[];
  }));

  const now=Date.now();
  const rows=settled
    .filter(result=>result.status==='fulfilled')
    .flatMap(result=>result.value)
    .filter(row=>Number(row?.league?.id)===Number(leagueId))
    .filter(row=>eventTime(row?.fixture?.date)>=now);

  return [...new Map(rows.map(row=>[String(row?.fixture?.id),row])).values()];
}

async function listCzFootballViaOdds(){
  const sports=await fetchOddsSports(false);
  const discovered=(sports||[])
    .filter(row=>String(row?.group||'').toLowerCase().includes('soccer'))
    .filter(row=>{
      const key=String(row?.key||'').toLowerCase();
      const title=String(row?.title||'').toLowerCase();
      const czech=key.includes('czech')||title.includes('czech');
      const firstLeague=
        key.includes('1_liga')||
        key.includes('first_league')||
        title.includes('1. liga')||
        title.includes('1 liga')||
        title.includes('first league');
      return czech&&firstLeague;
    })
    .map(row=>String(row?.key||''))
    .filter(Boolean);

  const keys=[...new Set(['soccer_czech_republic_1_liga',...discovered])];
  const results=await Promise.allSettled(keys.map(async key=>({
    key,
    events:await fetchOddsEvents(key)
  })));

  const now=Date.now();
  const events=[];
  for(const result of results){
    if(result.status!=='fulfilled')continue;
    for(const item of result.value.events||[]){
      const event=normalizeUpcomingEvent(item,'the-odds-api',result.value.key);
      if(event&&eventTime(event.commence_time)>=now)events.push(event);
    }
  }

  events.sort((a,b)=>eventTime(a.commence_time)-eventTime(b.commence_time));
  return [...new Map(events.map(event=>[event.provider+':'+event.id,event])).values()];
}

async function listCzFootballUpcoming(){
  const cacheKey='upcoming:cz_football';
  const cached=cacheGet(cacheKey);
  if(cached)return cached;

  const leagueId=Number(
    globalThis.Netlify?.env?.get?.('API_FOOTBALL_CZ_LEAGUE_ID')||
    process.env.API_FOOTBALL_CZ_LEAGUE_ID||
    345
  );
  const seasonOverride=globalThis.Netlify?.env?.get?.('API_FOOTBALL_CZ_SEASON')||process.env.API_FOOTBALL_CZ_SEASON;
  const season=/^\\d{4}$/.test(String(seasonOverride||''))
    ? Number(seasonOverride)
    : czFootballSeasonStart();
  const from=utcDateOffset(0);
  const to=utcDateOffset(35);

  let rows=[];
  const attempts=[
    {label:'league-season-window',params:{league:leagueId,season,from,to}},
    {label:'league-window',params:{league:leagueId,from,to}}
  ];

  for(const attempt of attempts){
    try{
      const payload=await apiFootball('fixtures',attempt.params);
      rows=payload?.response||[];
      if(rows.length)break;
    }catch(error){
      console.warn('Czech league '+attempt.label+' lookup failed:',error.message);
    }
  }

  const normalizeApiFootballRows=input=>{
    const now=Date.now();
    return (input||[])
      .filter(row=>!['CANC','PST','ABD','AWD','WO'].includes(String(row?.fixture?.status?.short||'').toUpperCase()))
      .map(row=>normalizeUpcomingEvent(row,'api-football'))
      .filter(Boolean)
      .filter(event=>eventTime(event.commence_time)>=now)
      .sort((a,b)=>eventTime(a.commence_time)-eventTime(b.commence_time));
  };

  let events=normalizeApiFootballRows(rows);

  if(!events.length){
    try{
      events=await listCzFootballViaOdds();
    }catch(error){
      console.warn('Czech league The Odds API fallback failed:',error.message);
    }
  }

  if(!events.length){
    try{
      events=normalizeApiFootballRows(await listCzFootballViaHeadToHead(leagueId));
    }catch(error){
      console.warn('Czech league head-to-head fallback failed:',error.message);
    }
  }

  if(!events.length){
    throw new ProviderError(
      'Nepodařilo se načíst nadcházející zápasy české ligy z dostupných zdrojů.',
      {status:502,code:'CZ_UPCOMING_UNAVAILABLE'}
    );
  }

  const unique=[...new Map(events.map(event=>[
    event.fixture_id?'api-football:'+event.fixture_id:event.provider+':'+event.id,
    event
  ])).values()];
  return cacheSet(cacheKey,unique.slice(0,30),10*60*1000);
}


const ESPN_NBA_BASE='https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const nbaTeamDirectoryCache={value:null,expires:0};
const nbaTeamStatsCache=new Map();
const nbaSummaryCache=new Map();
const nbaSeasonScheduleCache=new Map();

function numberFromScore(score){
  if(score==null)return null;
  if(typeof score==='number')return Number.isFinite(score)?score:null;
  if(typeof score==='string'){
    const n=Number(score);
    return Number.isFinite(n)?n:null;
  }
  const n=Number(score?.value??score?.displayValue);
  return Number.isFinite(n)?n:null;
}

function statEntry(stats,aliases){
  const wanted=new Set(aliases.map(normName));
  return (stats||[]).find(item=>{
    const candidates=[item?.name,item?.label,item?.abbreviation,item?.shortDisplayName].map(normName);
    return candidates.some(v=>wanted.has(v));
  })||null;
}

function numericStat(stats,aliases){
  const item=statEntry(stats,aliases);
  if(!item)return null;
  const candidates=[item?.value,item?.displayValue,item?.rawValue];
  for(const candidate of candidates){
    const n=Number(String(candidate??'').replace('%',''));
    if(Number.isFinite(n))return n;
  }
  return null;
}

function attemptedStat(stats,aliases){
  const item=statEntry(stats,aliases);
  if(!item)return null;
  const text=String(item?.displayValue??item?.value??'');
  const pair=text.match(/(\d+(?:\.\d+)?)\s*[-/]\s*(\d+(?:\.\d+)?)/);
  if(pair){
    const n=Number(pair[2]);
    return Number.isFinite(n)?n:null;
  }
  return null;
}

function estimatedPossessions(stats){
  const fga=attemptedStat(stats,[
    'fieldGoalsMade-fieldGoalsAttempted','fieldGoalsMadeFieldGoalsAttempted','FG'
  ]);
  const fta=attemptedStat(stats,[
    'freeThrowsMade-freeThrowsAttempted','freeThrowsMadeFreeThrowsAttempted','FT'
  ]);
  const oreb=numericStat(stats,['offensiveRebounds','OREB','offRebounds']);
  const tov=numericStat(stats,['turnovers','TO','TOV']);
  if([fga,fta,oreb,tov].some(v=>!Number.isFinite(v)))return null;
  return fga+0.44*fta-oreb+tov;
}

function average(values){
  const clean=values.filter(Number.isFinite);
  return clean.length?clean.reduce((sum,v)=>sum+v,0)/clean.length:null;
}

function roundMetric(value,digits=1){
  return Number.isFinite(value)?Number(value.toFixed(digits)):null;
}

export function espnSeasonYear(dateValue){
  const date=new Date(dateValue||Date.now());
  const year=date.getUTCFullYear();
  return date.getUTCMonth()+1>=7?year+1:year;
}

export function espnSeasonLabel(seasonYear){
  const endYear=Number(seasonYear);
  if(!Number.isFinite(endYear))return null;
  return `${endYear-1}/${String(endYear).slice(-2)}`;
}

export function nbaCurrentSeasonScheduleQueries(dateValue){
  const season=espnSeasonYear(dateValue);
  return [[season,2],[season,3]];
}

async function espnJson(path,params={}){
  const url=new URL(`${ESPN_NBA_BASE}/${String(path).replace(/^\//,'')}`);
  for(const[k,v]of Object.entries(params)){
    if(v!==null&&v!==undefined&&v!=='')url.searchParams.set(k,String(v));
  }
  return (await fetchJson(url,{headers:{accept:'application/json'}},'ESPN NBA')).data;
}

async function espnNbaTeamDirectory(){
  if(nbaTeamDirectoryCache.value&&nbaTeamDirectoryCache.expires>Date.now()){
    return nbaTeamDirectoryCache.value;
  }
  const payload=await espnJson('teams');
  const rows=payload?.sports?.[0]?.leagues?.[0]?.teams||[];
  const teams=rows.map(row=>row?.team).filter(Boolean);
  nbaTeamDirectoryCache.value=teams;
  nbaTeamDirectoryCache.expires=Date.now()+24*60*60*1000;
  return teams;
}

const ESPN_NBA_ALIASES={
  'losangelesclippers':'laclippers'
};

export async function resolveEspnNbaTeam(teamName){
  const teams=await espnNbaTeamDirectory();
  const wanted=ESPN_NBA_ALIASES[normName(teamName)]||normName(teamName);
  const exact=teams.find(team=>{
    const candidates=[
      team?.displayName,
      team?.shortDisplayName,
      team?.name,
      [team?.location,team?.name].filter(Boolean).join(' ')
    ].map(normName);
    return candidates.includes(wanted);
  });
  if(exact)return exact;

  const fuzzy=teams.find(team=>{
    const display=normName(team?.displayName);
    return display.includes(wanted)||wanted.includes(display);
  });
  if(fuzzy)return fuzzy;

  throw new ProviderError(
    `ESPN NBA nenašlo tým '${teamName}'.`,
    {status:404,code:'NBA_TEAM_NOT_FOUND'}
  );
}

async function fetchEspnTeamSchedule(teamId,season,seasontype){
  const cacheKey=`${teamId}:${season}:${seasontype}`;
  const cached=nbaSeasonScheduleCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.value;

  const promise=espnJson(`teams/${teamId}/schedule`,{season,seasontype})
    .then(payload=>payload?.events||[]);
  nbaSeasonScheduleCache.set(cacheKey,{value:promise,expires:Date.now()+30*60*1000});
  try{
    const value=await promise;
    nbaSeasonScheduleCache.set(cacheKey,{value,expires:Date.now()+30*60*1000});
    return value;
  }catch(error){
    nbaSeasonScheduleCache.delete(cacheKey);
    throw error;
  }
}

async function fetchEspnNbaSummary(eventId){
  const cached=nbaSummaryCache.get(String(eventId));
  if(cached&&cached.expires>Date.now())return cached.value;

  const promise=espnJson('summary',{event:eventId});
  nbaSummaryCache.set(String(eventId),{value:promise,expires:Date.now()+6*60*60*1000});
  try{
    const value=await promise;
    nbaSummaryCache.set(String(eventId),{value,expires:Date.now()+6*60*60*1000});
    return value;
  }catch(error){
    nbaSummaryCache.delete(String(eventId));
    throw error;
  }
}

function completedTeamGame(event,teamId,targetTime){
  const competition=event?.competitions?.[0];
  if(!competition)return null;
  const eventTime=Date.parse(event?.date||competition?.date||0);
  if(!Number.isFinite(eventTime)||eventTime>=targetTime)return null;
  const completed=Boolean(event?.status?.type?.completed||competition?.status?.type?.completed);
  const state=String(event?.status?.type?.state||competition?.status?.type?.state||'');
  if(!completed&&state!=='post')return null;

  const competitors=competition?.competitors||[];
  const team=competitors.find(row=>String(row?.team?.id)===String(teamId));
  const opponent=competitors.find(row=>String(row?.team?.id)!==String(teamId));
  if(!team||!opponent)return null;

  const pointsFor=numberFromScore(team?.score);
  const pointsAgainst=numberFromScore(opponent?.score);
  if(!Number.isFinite(pointsFor)||!Number.isFinite(pointsAgainst))return null;

  return {
    id:String(event?.id||competition?.id||''),
    date:event?.date||competition?.date||null,
    home_away:String(team?.homeAway||'').toLowerCase(),
    points_for:pointsFor,
    points_against:pointsAgainst,
    won:pointsFor>pointsAgainst,
    opponent:opponent?.team?.displayName||opponent?.team?.name||null
  };
}

export function classifyNbaDataAvailability(homeGames,awayGames){
  const home=Number(homeGames);
  const away=Number(awayGames);
  const valid=Number.isFinite(home)&&Number.isFinite(away);
  const minimum=valid?Math.min(home,away):0;

  if(!valid||minimum<3){
    return {
      analysis_available:false,
      data_status:'NEDOSTATEK DAT',
      reliability_status:'NEDOSTATEK DAT',
      minimum_completed_games:valid?minimum:null
    };
  }
  if(minimum<10){
    return {
      analysis_available:true,
      data_status:'OMEZENÁ SPOLEHLIVOST',
      reliability_status:'OMEZENÁ SPOLEHLIVOST',
      minimum_completed_games:minimum
    };
  }
  return {
    analysis_available:true,
    data_status:'PŘIPRAVENO',
    reliability_status:'STANDARDNÍ SPOLEHLIVOST',
    minimum_completed_games:minimum
  };
}

async function nbaCurrentSeasonCompletedCount(teamName,targetDate){
  const team=await resolveEspnNbaTeam(teamName);
  const season=espnSeasonYear(targetDate);
  const targetTime=Date.parse(targetDate||new Date().toISOString());
  const queries=nbaCurrentSeasonScheduleQueries(targetDate);

  const settled=await Promise.allSettled(
    queries.map(([seasonYear,seasontype])=>fetchEspnTeamSchedule(team.id,seasonYear,seasontype))
  );
  const games=[];
  for(const result of settled){
    if(result.status!=='fulfilled')continue;
    for(const event of result.value||[]){
      const game=completedTeamGame(event,team.id,targetTime);
      if(game)games.push(game);
    }
  }

  const unique=[...new Map(games.map(game=>[game.id,game])).values()];
  return {
    team_id:String(team.id),
    team_name:team.displayName||teamName,
    season_year:season,
    season_label:espnSeasonLabel(season),
    completed_games:unique.length
  };
}

async function enrichNbaUpcomingAvailability(events){
  const enriched=await Promise.all(events.map(async event=>{
    try{
      const [home,away]=await Promise.all([
        nbaCurrentSeasonCompletedCount(event.home_team,event.commence_time),
        nbaCurrentSeasonCompletedCount(event.away_team,event.commence_time)
      ]);
      const status=classifyNbaDataAvailability(home.completed_games,away.completed_games);
      return {
        ...event,
        ...status,
        nba_season_label:home.season_label||away.season_label||null,
        current_season_games:{
          home:home.completed_games,
          away:away.completed_games
        }
      };
    }catch(error){
      console.warn('NBA upcoming data availability check failed:',error.message);
      return {
        ...event,
        analysis_available:false,
        data_status:'NEDOSTATEK DAT',
        reliability_status:'NEDOSTATEK DAT',
        minimum_completed_games:null,
        current_season_games:{home:null,away:null},
        availability_error:error.message
      };
    }
  }));
  return enriched;
}

async function lastNbaGames(teamId,targetDate,wanted=10){
  const targetTime=Date.parse(targetDate||new Date().toISOString());
  const season=espnSeasonYear(targetDate);

  // Pouze aktuální NBA sezona: regular season + playoffs.
  // Žádný fallback do předchozí sezony.
  const queries=nbaCurrentSeasonScheduleQueries(targetDate);

  const settled=await Promise.allSettled(
    queries.map(([seasonYear,seasontype])=>fetchEspnTeamSchedule(teamId,seasonYear,seasontype))
  );
  const games=[];
  for(const result of settled){
    if(result.status!=='fulfilled')continue;
    for(const event of result.value||[]){
      const game=completedTeamGame(event,teamId,targetTime);
      if(game)games.push(game);
    }
  }

  const unique=[...new Map(games.map(game=>[game.id,game])).values()]
    .sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0))
    .slice(0,wanted);

  if(unique.length<3){
    throw new ProviderError(
      `V aktuální NBA sezoně ${espnSeasonLabel(season)} jsou před vybraným utkáním jen ${unique.length} dokončené zápasy. Model vyžaduje alespoň 3 a starší sezonu už nepoužívá.`,
      {status:422,code:'NBA_CURRENT_SEASON_TOO_FEW_GAMES'}
    );
  }

  return {games:unique,season};
}

function boxTeam(summary,teamId){
  return (summary?.boxscore?.teams||[]).find(
    row=>String(row?.team?.id)===String(teamId)
  )||null;
}

function formMetrics(games,location){
  const rows=games.filter(game=>game.home_away===location);
  if(!rows.length)return {
    games:0,wins:0,losses:0,win_pct:null,ppg:null,papg:null
  };
  const wins=rows.filter(game=>game.won).length;
  return {
    games:rows.length,
    wins,
    losses:rows.length-wins,
    win_pct:roundMetric(100*wins/rows.length,1),
    ppg:roundMetric(average(rows.map(game=>game.points_for)),1),
    papg:roundMetric(average(rows.map(game=>game.points_against)),1)
  };
}

export async function loadNbaTeamStats(teamName,targetDate){
  const cacheKey=`${normName(teamName)}:${String(targetDate||'now').slice(0,10)}`;
  const cached=nbaTeamStatsCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.value;

  const team=await resolveEspnNbaTeam(teamName);
  const {games,season}=await lastNbaGames(team.id,targetDate,10);
  const summaryResults=await Promise.allSettled(
    games.map(game=>fetchEspnNbaSummary(game.id))
  );

  const gameMetrics=[];
  for(let i=0;i<games.length;i+=1){
    const summaryResult=summaryResults[i];
    if(summaryResult.status!=='fulfilled')continue;
    const summary=summaryResult.value;
    const own=boxTeam(summary,team.id);
    const opponent=(summary?.boxscore?.teams||[]).find(
      row=>String(row?.team?.id)!==String(team.id)
    );
    if(!own||!opponent)continue;

    const ownPoss=estimatedPossessions(own.statistics);
    const oppPoss=estimatedPossessions(opponent.statistics);
    if(!Number.isFinite(ownPoss)||!Number.isFinite(oppPoss)||ownPoss<=0||oppPoss<=0)continue;

    const pace=(ownPoss+oppPoss)/2;
    gameMetrics.push({
      game_id:games[i].id,
      own_possessions:ownPoss,
      opp_possessions:oppPoss,
      pace,
      offensive_rating:100*games[i].points_for/ownPoss,
      defensive_rating:100*games[i].points_against/oppPoss
    });
  }

  const minimumBoxscores=Math.min(3,games.length);
  if(gameMetrics.length<minimumBoxscores){
    throw new ProviderError(
      `ESPN NBA poskytlo boxscore data pro pace/rating jen u ${gameMetrics.length} z ${games.length} zápasů týmu ${teamName}. Model vyžaduje alespoň ${minimumBoxscores}.`,
      {status:422,code:'NBA_NOT_ENOUGH_BOXSCORES'}
    );
  }

  const firstTime=Math.min(...games.map(game=>Date.parse(game.date)).filter(Number.isFinite));
  const lastTime=Math.max(...games.map(game=>Date.parse(game.date)).filter(Number.isFinite));
  const wins=games.filter(game=>game.won).length;
  const result={
    source:'ESPN NBA',
    source_mode:'espn-nba-last10',
    team_id:String(team.id),
    team_name:team.displayName||teamName,
    season_year:season,
    season_label:espnSeasonLabel(season),
    current_season_only:true,
    sample_complete:games.length>=10,
    matches_used:games.length,
    boxscores_used:gameMetrics.length,
    range:{
      from:Number.isFinite(firstTime)?new Date(firstTime).toISOString():null,
      to:Number.isFinite(lastTime)?new Date(lastTime).toISOString():null
    },
    wins,
    losses:games.length-wins,
    win_pct:roundMetric(100*wins/games.length,1),
    points_for:roundMetric(average(games.map(game=>game.points_for)),1),
    points_against:roundMetric(average(games.map(game=>game.points_against)),1),
    pace:roundMetric(average(gameMetrics.map(row=>row.pace)),1),
    offensive_rating:roundMetric(average(gameMetrics.map(row=>row.offensive_rating)),1),
    defensive_rating:roundMetric(average(gameMetrics.map(row=>row.defensive_rating)),1),
    home_form:formMetrics(games,'home'),
    away_form:formMetrics(games,'away'),
    last_game_date:Number.isFinite(lastTime)?new Date(lastTime).toISOString():null
  };

  if([
    result.points_for,result.points_against,result.pace,
    result.offensive_rating,result.defensive_rating
  ].some(value=>!Number.isFinite(value))){
    throw new ProviderError(
      `NBA statistiky týmu ${teamName} nejsou kompletní.`,
      {status:422,code:'NBA_STATS_INCOMPLETE'}
    );
  }

  nbaTeamStatsCache.set(cacheKey,{value:result,expires:Date.now()+30*60*1000});
  return result;
}


const NHL_WEB_BASE='https://api-web.nhle.com/v1';
const NHL_STATS_BASE='https://api.nhle.com/stats/rest/en';
const nhlTeamDirectoryCache={value:null,expires:0};
const nhlScheduleCache=new Map();
const nhlBoxscoreCache=new Map();
const nhlTeamStatsCache=new Map();

async function nhlWebJson(path,params={}){
  const url=new URL(`${NHL_WEB_BASE}/${String(path).replace(/^\//,'')}`);
  for(const[k,v]of Object.entries(params)){
    if(v!==null&&v!==undefined&&v!=='')url.searchParams.set(k,String(v));
  }
  return (await fetchJson(url,{headers:{accept:'application/json'}},'NHL API')).data;
}

async function nhlStatsJson(path,params={}){
  const url=new URL(`${NHL_STATS_BASE}/${String(path).replace(/^\//,'')}`);
  for(const[k,v]of Object.entries(params)){
    if(v!==null&&v!==undefined&&v!=='')url.searchParams.set(k,String(v));
  }
  return (await fetchJson(url,{headers:{accept:'application/json'}},'NHL Stats API')).data;
}

export function nhlSeasonId(dateValue){
  const date=new Date(dateValue||Date.now());
  const year=date.getUTCFullYear();
  const start=date.getUTCMonth()+1>=7?year:year-1;
  return Number(`${start}${start+1}`);
}

export function nhlSeasonLabel(seasonId){
  const text=String(seasonId||'');
  if(!/^\d{8}$/.test(text))return null;
  return `${text.slice(0,4)}/${text.slice(6,8)}`;
}

async function nhlTeamDirectory(){
  if(nhlTeamDirectoryCache.value&&nhlTeamDirectoryCache.expires>Date.now()){
    return nhlTeamDirectoryCache.value;
  }
  const payload=await nhlStatsJson('team',{limit:-1});
  const teams=payload?.data||[];
  nhlTeamDirectoryCache.value=teams;
  nhlTeamDirectoryCache.expires=Date.now()+24*60*60*1000;
  return teams;
}

export async function resolveNhlTeam(teamName){
  const teams=await nhlTeamDirectory();
  const wanted=normName(teamName);
  const exact=teams.find(team=>{
    const candidates=[
      team?.fullName,
      team?.name,
      team?.triCode,
      team?.rawTricode,
      team?.teamAbbrev
    ].map(normName);
    return candidates.includes(wanted);
  });
  if(exact)return exact;

  const fuzzy=teams.find(team=>{
    const full=normName(team?.fullName||team?.name);
    return full&&(
      full.includes(wanted)||
      wanted.includes(full)
    );
  });
  if(fuzzy)return fuzzy;

  throw new ProviderError(
    `NHL API nenašlo tým '${teamName}'.`,
    {status:404,code:'NHL_TEAM_NOT_FOUND'}
  );
}

function nhlTeamAbbrev(team){
  return String(
    team?.triCode||
    team?.rawTricode||
    team?.teamAbbrev||
    ''
  ).toUpperCase();
}

async function fetchNhlTeamSeasonSchedule(abbrev,seasonId){
  const key=`${abbrev}:${seasonId}`;
  const cached=nhlScheduleCache.get(key);
  if(cached&&cached.expires>Date.now())return cached.value;

  const promise=nhlWebJson(`club-schedule-season/${abbrev}/${seasonId}`)
    .then(payload=>payload?.games||[]);
  nhlScheduleCache.set(key,{value:promise,expires:Date.now()+30*60*1000});
  try{
    const value=await promise;
    nhlScheduleCache.set(key,{value,expires:Date.now()+30*60*1000});
    return value;
  }catch(error){
    nhlScheduleCache.delete(key);
    throw error;
  }
}

async function fetchNhlBoxscore(gameId){
  const key=String(gameId);
  const cached=nhlBoxscoreCache.get(key);
  if(cached&&cached.expires>Date.now())return cached.value;

  const promise=nhlWebJson(`gamecenter/${gameId}/boxscore`);
  nhlBoxscoreCache.set(key,{value:promise,expires:Date.now()+6*60*60*1000});
  try{
    const value=await promise;
    nhlBoxscoreCache.set(key,{value,expires:Date.now()+6*60*60*1000});
    return value;
  }catch(error){
    nhlBoxscoreCache.delete(key);
    throw error;
  }
}

function completedNhlTeamGame(game,abbrev,targetTime){
  const eventTime=Date.parse(game?.startTimeUTC||game?.gameDate||0);
  if(!Number.isFinite(eventTime)||eventTime>=targetTime)return null;
  if(![2,3].includes(Number(game?.gameType)))return null;
  const state=String(game?.gameState||'').toUpperCase();
  if(!['OFF','FINAL'].includes(state))return null;

  const home=String(game?.homeTeam?.abbrev||'').toUpperCase();
  const away=String(game?.awayTeam?.abbrev||'').toUpperCase();
  const isHome=home===abbrev;
  const isAway=away===abbrev;
  if(!isHome&&!isAway)return null;

  const own=isHome?game?.homeTeam:game?.awayTeam;
  const opp=isHome?game?.awayTeam:game?.homeTeam;
  const goalsFor=Number(own?.score);
  const goalsAgainst=Number(opp?.score);
  if(!Number.isFinite(goalsFor)||!Number.isFinite(goalsAgainst))return null;

  return {
    id:String(game?.id||''),
    date:game?.startTimeUTC||game?.gameDate||null,
    home_away:isHome?'home':'away',
    goals_for:goalsFor,
    goals_against:goalsAgainst,
    won:goalsFor>goalsAgainst,
    opponent:String(opp?.abbrev||'').toUpperCase()||null,
    last_period_type:game?.gameOutcome?.lastPeriodType||null
  };
}

async function currentSeasonNhlGames(teamName,targetDate,wanted=10){
  const team=await resolveNhlTeam(teamName);
  const abbrev=nhlTeamAbbrev(team);
  if(!abbrev){
    throw new ProviderError(
      `NHL API nemá zkratku týmu '${teamName}'.`,
      {status:502,code:'NHL_TEAM_ABBREV_MISSING'}
    );
  }

  const seasonId=nhlSeasonId(targetDate);
  const targetTime=Date.parse(targetDate||new Date().toISOString());
  const schedule=await fetchNhlTeamSeasonSchedule(abbrev,seasonId);

  const games=schedule
    .map(game=>completedNhlTeamGame(game,abbrev,targetTime))
    .filter(Boolean)
    .sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0));

  const unique=[...new Map(games.map(game=>[game.id,game])).values()].slice(0,wanted);
  return {
    team,
    abbrev,
    season_id:seasonId,
    season_label:nhlSeasonLabel(seasonId),
    games:unique,
    completed_games_total:games.length
  };
}

export function classifyNhlDataAvailability(homeGames,awayGames){
  const home=Number(homeGames);
  const away=Number(awayGames);
  const valid=Number.isFinite(home)&&Number.isFinite(away);
  const minimum=valid?Math.min(home,away):0;

  if(!valid||minimum<3){
    return {
      analysis_available:false,
      data_status:'NEDOSTATEK DAT',
      reliability_status:'NEDOSTATEK DAT',
      minimum_completed_games:valid?minimum:null
    };
  }
  if(minimum<10){
    return {
      analysis_available:true,
      data_status:'OMEZENÁ SPOLEHLIVOST',
      reliability_status:'OMEZENÁ SPOLEHLIVOST',
      minimum_completed_games:minimum
    };
  }
  return {
    analysis_available:true,
    data_status:'PŘIPRAVENO',
    reliability_status:'STANDARDNÍ SPOLEHLIVOST',
    minimum_completed_games:minimum
  };
}

async function enrichNhlUpcomingAvailability(events){
  const enriched=await Promise.all(events.map(async event=>{
    try{
      const [home,away]=await Promise.all([
        currentSeasonNhlGames(event.home_team,event.commence_time,10),
        currentSeasonNhlGames(event.away_team,event.commence_time,10)
      ]);
      const status=classifyNhlDataAvailability(
        home.completed_games_total,
        away.completed_games_total
      );
      return {
        ...event,
        ...status,
        nhl_season_label:home.season_label||away.season_label||null,
        current_season_games:{
          home:home.completed_games_total,
          away:away.completed_games_total
        }
      };
    }catch(error){
      console.warn('NHL upcoming data availability check failed:',error.message);
      return {
        ...event,
        analysis_available:false,
        data_status:'NEDOSTATEK DAT',
        reliability_status:'NEDOSTATEK DAT',
        minimum_completed_games:null,
        current_season_games:{home:null,away:null},
        availability_error:error.message
      };
    }
  }));
  return enriched;
}

function goalieSavePctForSide(boxscore,side){
  const goalies=boxscore?.playerByGameStats?.[side]?.goalies||[];
  if(!goalies.length)return null;

  const starter=goalies.find(goalie=>goalie?.starter===true)||
    goalies.slice().sort((a,b)=>{
      const parseToi=value=>{
        const [m,s]=String(value||'0:0').split(':').map(Number);
        return (Number.isFinite(m)?m:0)*60+(Number.isFinite(s)?s:0);
      };
      return parseToi(b?.toi)-parseToi(a?.toi);
    })[0];

  const pct=Number(starter?.savePctg);
  if(Number.isFinite(pct))return pct<=1?pct*100:pct;

  const shots=Number(starter?.shotsAgainst);
  const saves=Number(starter?.saves);
  return Number.isFinite(shots)&&shots>0&&Number.isFinite(saves)
    ? 100*saves/shots
    : null;
}

function nhlHomeAwayForm(games,location){
  const rows=games.filter(game=>game.home_away===location);
  if(!rows.length)return {
    games:0,wins:0,losses:0,win_pct:null,gfpg:null,gapg:null
  };
  const wins=rows.filter(game=>game.won).length;
  return {
    games:rows.length,
    wins,
    losses:rows.length-wins,
    win_pct:roundMetric(100*wins/rows.length,1),
    gfpg:roundMetric(average(rows.map(game=>game.goals_for)),2),
    gapg:roundMetric(average(rows.map(game=>game.goals_against)),2)
  };
}

export async function loadNhlTeamStats(teamName,targetDate){
  const cacheKey=`${normName(teamName)}:${String(targetDate||'now').slice(0,10)}`;
  const cached=nhlTeamStatsCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.value;

  const seasonData=await currentSeasonNhlGames(teamName,targetDate,10);
  const {games,abbrev}=seasonData;

  if(games.length<3){
    throw new ProviderError(
      `V aktuální NHL sezoně ${seasonData.season_label} jsou před vybraným utkáním jen ${games.length} dokončené zápasy týmu ${teamName}. Model vyžaduje alespoň 3 a starší sezonu nepoužívá.`,
      {status:422,code:'NHL_CURRENT_SEASON_TOO_FEW_GAMES'}
    );
  }

  const settled=await Promise.allSettled(games.map(game=>fetchNhlBoxscore(game.id)));
  const boxMetrics=[];
  for(let i=0;i<games.length;i+=1){
    const result=settled[i];
    if(result.status!=='fulfilled')continue;
    const box=result.value;
    const home=String(box?.homeTeam?.abbrev||'').toUpperCase();
    const side=home===abbrev?'homeTeam':'awayTeam';
    const oppSide=side==='homeTeam'?'awayTeam':'homeTeam';
    const own=side==='homeTeam'?box?.homeTeam:box?.awayTeam;
    const opp=oppSide==='homeTeam'?box?.homeTeam:box?.awayTeam;

    const shotsFor=Number(own?.sog);
    const shotsAgainst=Number(opp?.sog);
    const goalieSavePct=goalieSavePctForSide(box,side);

    boxMetrics.push({
      game_id:games[i].id,
      shots_for:Number.isFinite(shotsFor)?shotsFor:null,
      shots_against:Number.isFinite(shotsAgainst)?shotsAgainst:null,
      goalie_save_pct:Number.isFinite(goalieSavePct)?goalieSavePct:null
    });
  }

  const firstTime=Math.min(...games.map(game=>Date.parse(game.date)).filter(Number.isFinite));
  const lastTime=Math.max(...games.map(game=>Date.parse(game.date)).filter(Number.isFinite));
  const wins=games.filter(game=>game.won).length;
  const result={
    source:'NHL API',
    source_mode:'nhl-current-season-last10',
    team_abbrev:abbrev,
    team_name:teamName,
    season_id:seasonData.season_id,
    season_label:seasonData.season_label,
    current_season_only:true,
    sample_complete:games.length>=10,
    matches_used:games.length,
    range:{
      from:Number.isFinite(firstTime)?new Date(firstTime).toISOString():null,
      to:Number.isFinite(lastTime)?new Date(lastTime).toISOString():null
    },
    wins,
    losses:games.length-wins,
    win_pct:roundMetric(100*wins/games.length,1),
    goals_for:roundMetric(average(games.map(game=>game.goals_for)),2),
    goals_against:roundMetric(average(games.map(game=>game.goals_against)),2),
    shots_for:roundMetric(average(boxMetrics.map(row=>row.shots_for)),1),
    shots_against:roundMetric(average(boxMetrics.map(row=>row.shots_against)),1),
    goalie_save_pct:roundMetric(average(boxMetrics.map(row=>row.goalie_save_pct)),1),
    home_form:nhlHomeAwayForm(games,'home'),
    away_form:nhlHomeAwayForm(games,'away'),
    last_game_date:Number.isFinite(lastTime)?new Date(lastTime).toISOString():null,
    boxscores_used:boxMetrics.length
  };

  if(!Number.isFinite(result.goals_for)||!Number.isFinite(result.goals_against)){
    throw new ProviderError(
      `NHL statistiky týmu ${teamName} nejsou kompletní.`,
      {status:422,code:'NHL_STATS_INCOMPLETE'}
    );
  }

  nhlTeamStatsCache.set(cacheKey,{value:result,expires:Date.now()+30*60*1000});
  return result;
}

export async function fetchOddsSports(all=true){
  const api=process.env.ODDS_API_KEY;
  if(!api)throw new ProviderError('Chybí ODDS_API_KEY v Netlify environment variables.',{status:503,code:'MISSING_KEY'});
  const u=new URL(`${ODDS_API_BASE}/sports/`);
  u.searchParams.set('apiKey',api);
  if(all)u.searchParams.set('all','true');
  return (await fetchJson(u,{},'The Odds API')).data;
}

function oddsSportKeysForCategory(sport,sports){
  if(sport==='nba')return['basketball_nba'];
  if(sport==='nhl')return['icehockey_nhl'];
  if(sport==='tennis'){
    return (sports||[])
      .filter(row=>String(row?.group||'').toLowerCase().includes('tennis'))
      .map(row=>String(row?.key||''))
      .filter(key=>key.startsWith('tennis_atp_')||key.startsWith('tennis_wta_'))
      .slice(0,24);
  }
  if(sport==='fifa'){
    const preferred=new Set([
      'soccer_fifa_world_cup',
      'soccer_uefa_champs_league',
      'soccer_uefa_europa_league',
      'soccer_uefa_europa_conference_league',
      'soccer_uefa_nations_league',
      'soccer_uefa_euro'
    ]);
    const discovered=(sports||[])
      .filter(row=>String(row?.group||'').toLowerCase().includes('soccer'))
      .filter(row=>{
        const key=String(row?.key||'');
        const title=String(row?.title||'').toLowerCase();
        return preferred.has(key)||
          title.includes('fifa world cup')||
          title.includes('champions league')||
          title.includes('europa league')||
          title.includes('nations league')||
          title.includes('uefa euro');
      })
      .map(row=>row.key);
    return [...new Set([...preferred,...discovered])].slice(0,8);
  }
  return[];
}

async function listOddsUpcoming(sport){
  const cacheKey=`upcoming:${sport}`;
  const cached=cacheGet(cacheKey);
  if(cached)return cached;

  const sports=sport==='fifa'
    ? await fetchOddsSports(true)
    : sport==='tennis'
      ? await fetchOddsSports(false)
      : [];
  const keys=oddsSportKeysForCategory(sport,sports);
  const results=await Promise.allSettled(keys.map(async key=>({
    key,
    events:await fetchOddsEvents(key)
  })));
  const now=Date.now();
  const events=[];
  for(const result of results){
    if(result.status!=='fulfilled')continue;
    for(const item of result.value.events||[]){
      const event=normalizeUpcomingEvent(item,'the-odds-api',result.value.key);
      if(event&&eventTime(event.commence_time)>=now)events.push(event);
    }
  }
  events.sort((a,b)=>eventTime(a.commence_time)-eventTime(b.commence_time));
  const unique=[...new Map(events.map(event=>[`${event.provider}:${event.id}`,event])).values()];
  const limit=['nba','nhl','tennis'].includes(sport)?20:sport==='fifa'?12:40;
  return cacheSet(cacheKey,unique.slice(0,limit),5*60*1000);
}

export async function listUpcomingMatches(sport){
  if(sport==='cz_football')return listCzFootballUpcoming();
  if(sport==='nba'){
    const events=await listOddsUpcoming('nba');
    return enrichNbaUpcomingAvailability(events);
  }
  if(sport==='nhl'){
    const events=await listOddsUpcoming('nhl');
    return enrichNhlUpcomingAvailability(events);
  }
  if(sport==='fifa'){
    const events=await listOddsUpcoming('fifa');
    return enrichFifaUpcomingAvailability(events);
  }
  if(sport==='tennis'){
    const events=await listOddsUpcoming('tennis');
    return enrichTennisUpcomingAvailability(events);
  }
  throw new TypeError('Nepodporovaný sport.');
}

export async function fetchOddsEvents(key){const api=process.env.ODDS_API_KEY;if(!api)throw new ProviderError('Chybí ODDS_API_KEY v Netlify environment variables.',{status:503,code:'MISSING_KEY'});const u=new URL(`${ODDS_API_BASE}/sports/${key}/events`);u.searchParams.set('apiKey',api);u.searchParams.set('dateFormat','iso');return(await fetchJson(u,{},'The Odds API')).data;}
export async function fetchEventOdds(key,id,markets='h2h,spreads,totals',regions=null){const api=process.env.ODDS_API_KEY;if(!api)throw new ProviderError('Chybí ODDS_API_KEY v Netlify environment variables.',{status:503,code:'MISSING_KEY'});const u=new URL(`${ODDS_API_BASE}/sports/${key}/events/${id}/odds`);u.searchParams.set('apiKey',api);u.searchParams.set('regions',regions||process.env.ODDS_REGIONS||'eu');u.searchParams.set('markets',markets);u.searchParams.set('oddsFormat','decimal');u.searchParams.set('dateFormat','iso');const{data,response}=await fetchJson(u,{},'The Odds API');return{data,usage:{requests_remaining:response.headers.get('x-requests-remaining'),requests_used:response.headers.get('x-requests-used'),requests_last:response.headers.get('x-requests-last')}};}
export function findOddsEvent(events,sport,a,b){const wanted=new Set([normName(getOddsTeamName(sport,a)),normName(getOddsTeamName(sport,b))]);return(events||[]).find(e=>{const actual=new Set([normName(e?.home_team),normName(e?.away_team)]);return actual.size===wanted.size&&[...actual].every(v=>wanted.has(v));})||null;}
export function summarizeEventMarkets(event){const bookmakers=[],ml=new Map(),spreads=new Map(),totals=new Map(),push=(m,k,p)=>{if(!m.has(k))m.set(k,[]);m.get(k).push(p);};for(const b of event?.bookmakers||[]){const row={key:b.key,title:b.title,last_update:b.last_update,markets:{}};for(const m of b?.markets||[]){if(!['h2h','spreads','totals'].includes(m.key))continue;row.markets[m.key]=[];for(const o of m?.outcomes||[]){const item={name:o.name,price:o.price};if(typeof o.point==='number')item.point=o.point;row.markets[m.key].push(item);if(typeof o.price!=='number')continue;if(m.key==='h2h')push(ml,String(o.name),o.price);else if(m.key==='spreads'&&typeof o.point==='number')push(spreads,`${o.name}\0${o.point}`,o.price);else if(m.key==='totals'&&typeof o.point==='number')push(totals,`${o.name}\0${o.point}`,o.price);}}if(Object.keys(row.markets).length)bookmakers.push(row);}const avg=v=>Number((v.reduce((a,b)=>a+b,0)/v.length).toFixed(3));return{consensus:{moneyline:[...ml].map(([name,p])=>({name,average_price:avg(p),bookmakers:p.length})),spreads:[...spreads].map(([k,p])=>{const[name,point]=k.split('\0');return{name,point:Number(point),average_price:avg(p),bookmakers:p.length};}),totals:[...totals].map(([k,p])=>{const[name,point]=k.split('\0');return{name,point:Number(point),average_price:avg(p),bookmakers:p.length};})},bookmakers};}
export async function findMatchOdds({sport,teamA,teamB,markets='h2h,spreads,totals',regions=null}){if(!TEAM_MAPPING[sport])throw new TypeError('Nepodporovaný sport.');if(!teamA||!teamB||teamA===teamB)throw new TypeError('Zadej dva různé týmy.');const allowed=new Set(['h2h','spreads','totals']),requested=[...new Set(String(markets).split(',').map(v=>v.trim()).filter(Boolean))];if(!requested.length||requested.some(v=>!allowed.has(v)))throw new TypeError('markets může obsahovat pouze h2h, spreads a totals.');const key=getOddsSportKey(sport,teamA,teamB);if(!key)throw new TypeError(`Pro sport '${sport}' nelze určit The Odds API sport key. Nastav ODDS_SPORT_* environment variable.`);const event=findOddsEvent(await fetchOddsEvents(key),sport,teamA,teamB);if(!event){const e=new Error(`The Odds API nenašlo zápas ${teamA} vs ${teamB} pro sport key '${key}'.`);e.status=404;e.code='EVENT_NOT_FOUND';throw e;}if(!event.id)throw new ProviderError('Nalezený event nemá event ID.',{status:502,code:'MISSING_EVENT_ID'});const{data,usage}=await fetchEventOdds(key,String(event.id),requested.join(','),regions),summary=summarizeEventMarkets(data);return{sport,sport_key:key,requested_teams:{team_a:teamA,team_b:teamB},matched_event:{id:String(event.id),home_team:data.home_team||event.home_team,away_team:data.away_team||event.away_team,commence_time:data.commence_time||event.commence_time},markets_requested:requested,markets:summary.consensus,bookmakers:summary.bookmakers,api_usage:usage};}
