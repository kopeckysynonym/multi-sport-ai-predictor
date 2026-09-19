import { TEAM_MAPPING } from './data.mjs';
import { fetchJson, ProviderError } from './http.mjs';
const API_FOOTBALL_BASE=(process.env.API_FOOTBALL_BASE||'https://v3.football.api-sports.io').replace(/\/$/,'');const ODDS_API_BASE=(process.env.ODDS_API_BASE||'https://api.the-odds-api.com/v4').replace(/\/$/,'');const teamIdCache=new Map(),liveFootballCache=new Map();let apiFootballSeasonRangeCache=null;
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

export async function loadApiFootballCzOdds(teamA,teamB){
  const [idA,idB]=await Promise.all([
    resolveApiFootballTeamId('cz_football',teamA),
    resolveApiFootballTeamId('cz_football',teamB)
  ]);

  const h2h=await apiFootball('fixtures/headtohead',{h2h:`${idA}-${idB}`});
  const now=Date.now();
  const future=(h2h?.response||[])
    .filter(item=>{
      const when=Date.parse(item?.fixture?.date||0);
      const status=String(item?.fixture?.status?.short||'');
      return when>=now&&['NS','TBD'].includes(status);
    })
    .sort((x,y)=>Date.parse(x?.fixture?.date||0)-Date.parse(y?.fixture?.date||0));

  const exact=future.find(item=>Number(item?.teams?.home?.id)===idA&&Number(item?.teams?.away?.id)===idB);
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

export async function fetchOddsEvents(key){const api=process.env.ODDS_API_KEY;if(!api)throw new ProviderError('Chybí ODDS_API_KEY v Netlify environment variables.',{status:503,code:'MISSING_KEY'});const u=new URL(`${ODDS_API_BASE}/sports/${key}/events`);u.searchParams.set('apiKey',api);u.searchParams.set('dateFormat','iso');return(await fetchJson(u,{},'The Odds API')).data;}
export async function fetchEventOdds(key,id,markets='h2h,spreads,totals',regions=null){const api=process.env.ODDS_API_KEY;if(!api)throw new ProviderError('Chybí ODDS_API_KEY v Netlify environment variables.',{status:503,code:'MISSING_KEY'});const u=new URL(`${ODDS_API_BASE}/sports/${key}/events/${id}/odds`);u.searchParams.set('apiKey',api);u.searchParams.set('regions',regions||process.env.ODDS_REGIONS||'eu');u.searchParams.set('markets',markets);u.searchParams.set('oddsFormat','decimal');u.searchParams.set('dateFormat','iso');const{data,response}=await fetchJson(u,{},'The Odds API');return{data,usage:{requests_remaining:response.headers.get('x-requests-remaining'),requests_used:response.headers.get('x-requests-used'),requests_last:response.headers.get('x-requests-last')}};}
export function findOddsEvent(events,sport,a,b){const wanted=new Set([normName(getOddsTeamName(sport,a)),normName(getOddsTeamName(sport,b))]);return(events||[]).find(e=>{const actual=new Set([normName(e?.home_team),normName(e?.away_team)]);return actual.size===wanted.size&&[...actual].every(v=>wanted.has(v));})||null;}
export function summarizeEventMarkets(event){const bookmakers=[],ml=new Map(),spreads=new Map(),totals=new Map(),push=(m,k,p)=>{if(!m.has(k))m.set(k,[]);m.get(k).push(p);};for(const b of event?.bookmakers||[]){const row={key:b.key,title:b.title,last_update:b.last_update,markets:{}};for(const m of b?.markets||[]){if(!['h2h','spreads','totals'].includes(m.key))continue;row.markets[m.key]=[];for(const o of m?.outcomes||[]){const item={name:o.name,price:o.price};if(typeof o.point==='number')item.point=o.point;row.markets[m.key].push(item);if(typeof o.price!=='number')continue;if(m.key==='h2h')push(ml,String(o.name),o.price);else if(m.key==='spreads'&&typeof o.point==='number')push(spreads,`${o.name}\0${o.point}`,o.price);else if(m.key==='totals'&&typeof o.point==='number')push(totals,`${o.name}\0${o.point}`,o.price);}}if(Object.keys(row.markets).length)bookmakers.push(row);}const avg=v=>Number((v.reduce((a,b)=>a+b,0)/v.length).toFixed(3));return{consensus:{moneyline:[...ml].map(([name,p])=>({name,average_price:avg(p),bookmakers:p.length})),spreads:[...spreads].map(([k,p])=>{const[name,point]=k.split('\0');return{name,point:Number(point),average_price:avg(p),bookmakers:p.length};}),totals:[...totals].map(([k,p])=>{const[name,point]=k.split('\0');return{name,point:Number(point),average_price:avg(p),bookmakers:p.length};})},bookmakers};}
export async function findMatchOdds({sport,teamA,teamB,markets='h2h,spreads,totals',regions=null}){if(!TEAM_MAPPING[sport])throw new TypeError('Nepodporovaný sport.');if(!teamA||!teamB||teamA===teamB)throw new TypeError('Zadej dva různé týmy.');const allowed=new Set(['h2h','spreads','totals']),requested=[...new Set(String(markets).split(',').map(v=>v.trim()).filter(Boolean))];if(!requested.length||requested.some(v=>!allowed.has(v)))throw new TypeError('markets může obsahovat pouze h2h, spreads a totals.');const key=getOddsSportKey(sport,teamA,teamB);if(!key)throw new TypeError(`Pro sport '${sport}' nelze určit The Odds API sport key. Nastav ODDS_SPORT_* environment variable.`);const event=findOddsEvent(await fetchOddsEvents(key),sport,teamA,teamB);if(!event){const e=new Error(`The Odds API nenašlo zápas ${teamA} vs ${teamB} pro sport key '${key}'.`);e.status=404;e.code='EVENT_NOT_FOUND';throw e;}if(!event.id)throw new ProviderError('Nalezený event nemá event ID.',{status:502,code:'MISSING_EVENT_ID'});const{data,usage}=await fetchEventOdds(key,String(event.id),requested.join(','),regions),summary=summarizeEventMarkets(data);return{sport,sport_key:key,requested_teams:{team_a:teamA,team_b:teamB},matched_event:{id:String(event.id),home_team:data.home_team||event.home_team,away_team:data.away_team||event.away_team,commence_time:data.commence_time||event.commence_time},markets_requested:requested,markets:summary.consensus,bookmakers:summary.bookmakers,api_usage:usage};}
